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
    const { system, messages } = toAnthropicMessages(opts.messages);

    const body: Record<string, unknown> = {
      model: this.config.model,
      // Anthropic 强制要求 max_tokens；未给时给一个合理默认
      max_tokens: opts.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      messages,
      stream: true,
      ...(opts.tools && opts.tools.length > 0
        ? { tools: opts.tools.map(toAnthropicTool) }
        : {}),
    };

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': this.config.anthropicVersion ?? '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic 请求失败 ${res.status}: ${text}`);
    }

    return this.parseStream(res.body, opts.onText);
  }

  /**
   * 解析 Anthropic 命名事件流。逐行累积 `event:` / `data:`，
   * 遇到空行触发一次 dispatch（一个完整事件 = 一对 event+data）。
   */
  private async parseStream(
    stream: ReadableStream<Uint8Array>,
    onText?: (chunk: string) => void,
  ): Promise<CompleteResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataBuf = '';
    let content = '';
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

    return { content, toolCalls: parsedToolCalls, raw: undefined };
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

/** 把 ChatMessage[] 翻译成 Anthropic 的 {system, messages} */
function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: unknown[] } {
  let system = '';
  const out: unknown[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system += extractText(m.content) + '\n';
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

  return { system: system.trim(), messages: out };
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

/** 把 ToolDef 转成 Anthropic tool 声明（注意字段是 input_schema，不是 parameters） */
function toAnthropicTool(tool: ToolDef): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}
