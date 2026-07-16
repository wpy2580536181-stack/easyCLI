// Phase 11（多模型适配补全）：Anthropic (Claude) 适配器。
//
// Anthropic 的 Messages API 与 OpenAI 差异较大，适配器要处理的「格式翻译」关键有三处：
//
// 1. system 不是一条消息，而是请求体的顶层字段；
// 2. 工具结果没有独立的 role，而是作为 `user` 消息里的 `tool_result` content block；
// 3. 流式协议是「命名事件（named SSE events）」而非 OpenAI 的裸 data 帧：
//    content_block_start / content_block_delta / content_block_stop / message_delta / message_stop。
//   工具调用的参数以 `input_json_delta` 的 partial_json 分片下发，需按块 index 累积再 JSON.parse。
//
// 我们仍实现统一的 ChatModel 接口，让上层（ReAct 循环）对厂商差异无感知。

import type {
  ChatMessage,
  ChatModel,
  CompleteOptions,
  CompleteResult,
  ToolCall,
  ToolDef,
  ContentBlock,
} from './types';
import { classifyFetchError, ModelRequestError } from './errors';
import { historyBreakpointIndex } from './cache';
import { dispatcherForUrl, type FetchInit } from '../http/proxy';

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  /** 默认 https://api.anthropic.com；可指向兼容网关 */
  baseURL?: string;
  /** Anthropic API 版本头，默认 2023-06-01 */
  anthropicVersion?: string;
}

interface StreamToolCall {
  id?: string;
  name?: string;
  args: string;
}

export class AnthropicAdapter implements ChatModel {
  private readonly endpoint: string;

  constructor(private readonly config: AnthropicConfig) {
    const base = (config.baseURL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.endpoint = `${base}/v1/messages`;
  }

  get id(): string {
    return `anthropic:${this.config.model}`;
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const cacheSystem = opts.cache?.system !== false;
    const cacheTools = opts.cache?.tools !== false;
    const cacheHistory = opts.cache?.history === true;
    const { system, messages } = toAnthropicMessages(opts.messages, cacheSystem, cacheHistory);
    // 代理出口：同 OpenAI 适配器，使 LLM 请求在有代理环境下走出口代理。
    const dispatcher = dispatcherForUrl(this.endpoint);

    const body: Record<string, unknown> = {
      model: this.config.model,
      // Anthropic 强制要求 max_tokens；未给时给一个合理默认
      max_tokens: opts.maxTokens ?? 4096,
      ...(system.length ? { system } : {}),
      messages,
      stream: true,
      ...(opts.tools && opts.tools.length > 0
        ? {
            tools: opts.tools.map((t, i) =>
              toAnthropicTool(t, cacheTools && i === opts.tools!.length - 1),
            ),
          }
        : {}),
    };

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': this.config.anthropicVersion ?? '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
        dispatcher,
      } as FetchInit);
    } catch (e) {
      throw classifyFetchError(e, `调用 ${this.config.model}`);
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new ModelRequestError('http', `模型服务返回错误 ${res.status}: ${text}`, res.status);
    }

    return this.parseStream(res.body, opts.onText, opts.onReasoning);
  }

  /**
   * 解析 Anthropic 命名事件流。逐行累积 `event:` / `data:`，
   * 遇到空行触发一次 dispatch（一个完整事件 = 一对 event+data）。
   */
  private async parseStream(
    stream: ReadableStream<Uint8Array>,
    onText?: (chunk: string) => void,
    onReasoning?: (chunk: string) => void,
  ): Promise<CompleteResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataBuf = '';
    let content = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let cacheCreationTokens: number | undefined;
    const toolCalls = new Map<number, StreamToolCall>();

    const dispatch = (): void => {
      const data = dataBuf;
      dataBuf = '';
      if (!data) return;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return; // 跳过非 JSON 行
      }

      switch (json.type) {
        case 'message_start': {
          // input_tokens 在 message_start 的 usage 里（含 cache 命中/创建）
          const it = json?.message?.usage?.input_tokens;
          if (typeof it === 'number') inputTokens = it;
          // 前缀缓存可观测：命中(cache_read) 与新建(cache_creation) 分别回报
          const cr = json?.message?.usage?.cache_read_input_tokens;
          const cc = json?.message?.usage?.cache_creation_input_tokens;
          if (typeof cr === 'number') cacheReadTokens = cr;
          if (typeof cc === 'number') cacheCreationTokens = cc;
          break;
        }
        case 'message_delta': {
          // output_tokens 在 message_delta 的 usage 里
          const ot = json?.usage?.output_tokens;
          if (typeof ot === 'number') outputTokens = ot;
          break;
        }
        case 'content_block_start': {
          // 工具调用开始：记下 id 与 name
          const cb = json.content_block;
          if (cb?.type === 'tool_use') {
            toolCalls.set(json.index, { id: cb.id, name: cb.name, args: '' });
          }
          break;
        }
        case 'content_block_delta': {
          const d = json.delta;
          if (d?.type === 'text_delta' && d.text) {
            content += d.text;
            onText?.(d.text);
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            // Anthropic extended thinking：推理内容走独立通道，不混入正式文本
            onReasoning?.(d.thinking);
          } else if (d?.type === 'input_json_delta' && d.partial_json) {
            // 工具参数分片：按块 index 累积
            const entry =
              toolCalls.get(json.index) ?? { id: undefined, name: undefined, args: '' };
            entry.args += d.partial_json;
            toolCalls.set(json.index, entry);
          }
          break;
        }
        // message_delta / message_stop / ping 等无需处理
        default:
          break;
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.startsWith('event:')) {
          // 仅记录事件名即可（本解析不依赖 event 名，统一在 data 里判断 type）
          continue;
        } else if (line.startsWith('data:')) {
          dataBuf = line.slice(5).trim();
        } else if (line.trim() === '') {
          dispatch();
        }
      }
    }
    dispatch(); // flush 收尾残留

    const parsedToolCalls: ToolCall[] = [];
    for (const entry of toolCalls.values()) {
      let args: Record<string, unknown> = {};
      if (entry.args.trim()) {
        try {
          args = JSON.parse(entry.args) as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      parsedToolCalls.push({ id: entry.id ?? '', name: entry.name ?? '', arguments: args });
    }

    // 翻译真实用量（message_start 给 input，message_delta 给 output；任一存在即记录）
    const usage =
      inputTokens != null ||
      outputTokens != null ||
      cacheReadTokens != null ||
      cacheCreationTokens != null
        ? {
            promptTokens: inputTokens ?? 0,
            completionTokens: outputTokens ?? 0,
            totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
            ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
            ...(cacheCreationTokens != null ? { cacheCreationTokens } : {}),
          }
        : undefined;
    return {
      content,
      toolCalls: parsedToolCalls,
      raw: undefined,
      ...(usage ? { usage } : {}),
    };
  }
}

/** 提取文本块里的纯文本（content 为数组时） */
function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** 把 ChatMessage[] 翻译成 Anthropic 的 {system, messages}。
 *  system 返回为 block 数组（而非字符串），以便在其末块打 cache_control 断点。 */
function toAnthropicMessages(
  messages: ChatMessage[],
  cacheSystem: boolean,
  cacheHistory = false,
): { system: unknown[]; messages: unknown[] } {
  const system: unknown[] = [];
  const out: unknown[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system.push({ type: 'text', text: extractText(m.content) });
      continue;
    }

    if (m.role === 'user') {
      const content = toAnthropicContent(m.content);
      out.push({ role: 'user', content });
      continue;
    }

    if (m.role === 'assistant') {
      const content = toAnthropicAssistantContent(m.content);
      out.push({ role: 'assistant', content });
      continue;
    }

    if (m.role === 'tool') {
      // 工具结果：挂到最近一个 user 消息的 tool_result 块里（连续多条 tool 合并进同一 user）
      const toolResult = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: extractText(m.content),
      };
      const last = out[out.length - 1] as { role?: string; content?: unknown } | undefined;
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as unknown[]).push(toolResult);
      } else {
        out.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }
  }

  // 若开启 system 缓存，在最后一个 system block 上打 cache_control 断点
  if (cacheSystem && system.length) {
    const last = system[system.length - 1] as { type: 'text'; text: string; cache_control?: unknown };
    last.cache_control = { type: 'ephemeral' };
  }

  // 历史稳定段缓存：在「除当前轮外」的最后一条消息末块打 cache_control。
  // out 已去掉 system（提取到顶层），故这里的索引即非 system 消息的相对序，
  // 与 historyBreakpointIndex 在去 system 后的数组上算出的结果一致。
  if (cacheHistory) {
    const k = historyBreakpointIndex(out as ChatMessage[]);
    if (k >= 0) markLastBlock(out[k] as { content?: unknown });
  }
  return { system, messages: out };
}

/** 在一条已翻译消息的「最后一个内容块」上打 cache_control 断点。
 * 内容可能是字符串（包成 text block 数组）或 block 数组（取末块）。 */
function markLastBlock(msg: { content?: unknown }): void {
  const content = msg.content;
  if (typeof content === 'string') {
    msg.content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (Array.isArray(content) && content.length) {
    const last = content[content.length - 1] as { cache_control?: unknown };
    last.cache_control = { type: 'ephemeral' };
  }
}

/** user 消息内容：字符串直接给字符串，数组则转成 text block 数组 */
function toAnthropicContent(content: string | ContentBlock[]): unknown {
  if (typeof content === 'string') return content;
  // user 消息只可能含文本块；过滤掉非文本块以保类型安全
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => ({ type: 'text', text: b.text }));
}

/** assistant 消息内容：文本 → text block；工具调用 → tool_use block（input 为已解析参数对象） */
function toAnthropicAssistantContent(content: string | ContentBlock[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    return { type: 'tool_use', id: b.id, name: b.name, input: b.arguments };
  });
}

/** 把 ToolDef 转成 Anthropic tool 声明（注意字段是 input_schema，不是 parameters）。
 * mark=true 时在末个工具上加 cache_control 断点（工具定义属稳定前缀，值得缓存）。 */
function toAnthropicTool(tool: ToolDef, mark?: boolean): unknown {
  const t = {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
  if (mark) (t as { cache_control?: unknown }).cache_control = { type: 'ephemeral' };
  return t;
}
