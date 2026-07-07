import type {
  ChatMessage,
  ChatModel,
  CompleteOptions,
  CompleteResult,
  ToolCall,
  ToolDef,
} from './types';

export interface OpenAIConfig {
  /** 例如 https://api.deepseek.com/v1 */
  baseURL: string;
  apiKey: string;
  model: string;
  /** 透传到请求体的额外字段（如 DeepSeek 的 enable_thinking） */
  extraBody?: Record<string, unknown>;
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
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOpenAIMessages(opts.messages),
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.tools && opts.tools.length > 0
        ? { tools: opts.tools.map(toOpenAITool) }
        : {}),
      // 请求真实 token 用量（OpenAI 流式默认不回报，需显式开启）。
      // 绝大多数 OpenAI 兼容服务忽略未知字段，无需担心兼容性。
      stream_options: { include_usage: true },
      ...this.config.extraBody,
    };

    const res = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI 请求失败 ${res.status}: ${text}`);
    }

    return this.parseStream(res.body, opts.onText);
  }

  private async parseStream(
    stream: ReadableStream<Uint8Array>,
    onText?: (chunk: string) => void,
  ): Promise<CompleteResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let lastUsage: any;
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
        if (json?.usage) lastUsage = json.usage;

        const delta = json?.choices?.[0]?.delta;
        if (!delta) continue;

        // 普通文本增量
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onText?.(delta.content);
        }
        // DeepSeek 思考过程（reasoning_content）
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          onText?.(delta.reasoning_content);
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

/** 把 ToolDef 转成 OpenAI function 声明 */
function toOpenAITool(tool: ToolDef): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}
