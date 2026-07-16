import type {
  ChatMessage,
  ChatModel,
  CompleteOptions,
  CompleteResult,
  ToolCall,
  ToolDef,
} from './types';
import { classifyFetchError, ModelRequestError } from './errors';
import { historyBreakpointIndex, markLastContentBlock } from './cache';
import { dispatcherForUrl, type FetchInit } from '../http/proxy';

export interface OpenAIConfig {
  /** 例如 https://api.deepseek.com/v1 */
  baseURL: string;
  apiKey: string;
  model: string;
  /** 透传到请求体的额外字段（如 DeepSeek 的 enable_thinking） */
  extraBody?: Record<string, unknown>;
  /**
   * 是否使用 SSE 流式输出（默认 true）。
   * 部分 OpenAI 兼容网关（如 agnes）不支持流式，开启 stream:true 时服务端不推送任何数据并一直保持连接，
   * 导致调用挂起。设为 false 时走一次性 JSON POST，拿到完整结果后通过 onText 回吐。
   */
  stream?: boolean;
}

interface StreamToolCall {
  id?: string;
  name?: string;
  args: string;
}

/**
 * 首批模型适配器：对接所有 OpenAI 兼容协议的服务
 * （DeepSeek / GLM / Kimi / Qwen 等）。
 *
 * 关键点（也是本模块的学习目标）：
 * 1. 手写 SSE 解析——逐行读 data: 帧，遇到 [DONE] 结束。
 * 2. 流式增量通过 onText 回调上抛，让渲染器边收边打印。
 * 3. tool_calls 是分片下发的，需按 index 累积拼接后再 JSON.parse。
 * 4. 兼容 DeepSeek 的 reasoning_content（思考过程）。
 */
export class OpenAICompatibleAdapter implements ChatModel {
  constructor(private readonly config: OpenAIConfig) {}

  get id(): string {
    return `openai:${this.config.model}`;
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const cacheSystem = opts.cache?.system !== false;
    const cacheTools = opts.cache?.tools !== false;
    const cacheHistory = opts.cache?.history === true;
    // 代理出口：配置了 HTTPS_PROXY/HTTP_PROXY 时，让 LLM 请求走与 web 工具相同的出口代理
    // （localhost/私网/NO_PROXY 目标会自动绕过，见 ./proxy）。
    const dispatcher = dispatcherForUrl(this.config.baseURL);
    // 把消息翻译出来，便于在首个 system 块上打 cache_control 断点（OpenAI 兼容网关多忽略未知字段）
    const messages = toOpenAIMessages(opts.messages) as Array<Record<string, unknown>>;
    if (cacheSystem) {
      const idx = messages.findIndex((m) => m.role === 'system');
      if (idx >= 0 && typeof messages[idx]!.content === 'string') {
        messages[idx]!.content = [
          { type: 'text', text: messages[idx]!.content, cache_control: { type: 'ephemeral' } },
        ];
      }
    }
    // 历史稳定段缓存：在「除当前轮外」最后一条消息末块打 cache_control。
    // 与 Anthropic 同源：system + tools + 几乎整段历史整体成为可缓存前缀（多轮高命中）。
    if (cacheHistory) {
      const k = historyBreakpointIndex(messages as unknown as ChatMessage[]);
      if (k >= 0) markLastContentBlock(messages[k]!);
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.tools && opts.tools.length > 0
        ? {
            tools: opts.tools.map((t, i) =>
              toOpenAITool(t, cacheTools && i === opts.tools!.length - 1),
            ),
          }
        : {}),
      // 请求真实 token 用量（OpenAI 流式默认不回报，需显式开启）。
      // 绝大多数 OpenAI 兼容服务忽略未知字段，无需担心兼容性。
      stream_options: { include_usage: true },
      ...this.config.extraBody,
    };

    // 非流式模式：部分网关不支持 SSE，开启 stream:true 会一直挂起。
    // 此时走普通 JSON POST，拿到完整结果后通过 onText 一次性回吐（渲染管线不变）。
    if (this.config.stream === false) {
      const nonStreamBody: Record<string, unknown> = { ...body, stream: false };
      delete (nonStreamBody as Record<string, unknown>).stream_options;
      let res: Response;
      try {
        res = await fetch(`${this.config.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(nonStreamBody),
          signal: opts.signal,
          dispatcher,
        } as FetchInit);
      } catch (e) {
        throw classifyFetchError(e, `调用 ${this.config.model}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ModelRequestError('http', `模型服务返回错误 ${res.status}: ${text}`, res.status);
      }
      const json = (await res.json().catch(() => null)) as any;
      const msg = json?.choices?.[0]?.message;
      const text = typeof msg?.content === 'string' ? msg.content : '';
      if (text) opts.onText?.(text);
      const usage = json?.usage
        ? {
            promptTokens: Number(json.usage.prompt_tokens ?? 0),
            completionTokens: Number(json.usage.completion_tokens ?? 0),
            totalTokens: Number(json.usage.total_tokens ?? 0),
            ...(typeof json.usage?.prompt_tokens_details?.cached_tokens === 'number'
              ? { cacheReadTokens: json.usage.prompt_tokens_details.cached_tokens }
              : {}),
          }
        : undefined;
      const toolCalls: ToolCall[] = Array.isArray(msg?.tool_calls)
        ? msg.tool_calls.map((tc: any) => ({
            id: tc?.id ?? '',
            name: tc?.function?.name ?? '',
            arguments: parseToolCallArgs(tc?.function?.arguments),
          }))
        : [];
      return { content: text, toolCalls, raw: undefined, ...(usage ? { usage } : {}) };
    }

    let res: Response;
    try {
      res = await fetch(`${this.config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
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

  private async parseStream(
    stream: ReadableStream<Uint8Array>,
    onText?: (chunk: string) => void,
    onReasoning?: (chunk: string) => void,
  ): Promise<CompleteResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let lastUsage: any;
    let cacheReadTokens: number | undefined;
    const toolCalls = new Map<number, StreamToolCall>();

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;

        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // 跳过非 JSON 行（注释/心跳）
        }

        // 真实用量通常在 [DONE] 前的最后一个分片回报（choices 可能为空），先记下
        if (json?.usage) {
          lastUsage = json.usage;
          const ct = json.usage?.prompt_tokens_details?.cached_tokens;
          if (typeof ct === 'number') cacheReadTokens = ct;
        }

        const delta = json?.choices?.[0]?.delta;
        if (!delta) continue;

        // 普通文本增量
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onText?.(delta.content);
        }
        // DeepSeek 思考过程（reasoning_content）——独立通道，不混入正式文本
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          onReasoning?.(delta.reasoning_content);
        }
        // 工具调用（分片下发，按 index 累积）
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as any[]) {
            const idx = tc.index ?? 0;
            const entry = toolCalls.get(idx) ?? { args: '' };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') entry.args += tc.function.arguments;
            toolCalls.set(idx, entry);
          }
        }
      }
    }

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

    // 翻译真实用量（仅当流式回报了 usage 时存在；否则由上层估算）
    const usage = lastUsage
      ? {
          promptTokens: Number(lastUsage.prompt_tokens ?? 0),
          completionTokens: Number(lastUsage.completion_tokens ?? 0),
          totalTokens: Number(lastUsage.total_tokens ?? 0),
          ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
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

/** 解析工具调用参数 JSON 字符串（非流式一次性返回时复用） */
function parseToolCallArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 把我们的 ChatMessage 转成 OpenAI 消息格式 */
function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    // 内容块数组
    if (m.role === 'assistant') {
      let text = '';
      const tool_calls: unknown[] = [];
      for (const block of m.content) {
        if (block.type === 'text') text += block.text;
        else tool_calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments) } });
      }
      return { role: 'assistant', content: text, ...(tool_calls.length ? { tool_calls } : {}) };
    }
    if (m.role === 'tool') {
      const block = m.content.find((b) => b.type === 'text');
      return { role: 'tool', tool_call_id: m.tool_call_id, content: block?.text ?? '' };
    }
    const text = m.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { role: m.role, content: text };
  });
}

/** 把 ToolDef 转成 OpenAI function 声明。
 * mark=true 时在末个工具上加 cache_control 断点（工具定义属稳定前缀，值得缓存）。 */
function toOpenAITool(tool: ToolDef, mark?: boolean): unknown {
  const t: Record<string, unknown> = {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
  if (mark) t.cache_control = { type: 'ephemeral' };
  return t;
}
