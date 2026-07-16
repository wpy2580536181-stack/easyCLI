// 全局共享类型：Provider 无关的归一化契约。
// 后续各期（AnthropicAdapter / OllamaAdapter、ReAct、MCP）都基于这套类型，不要随意改字段。

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 单条内容块——目前只需文本与工具调用两种 */
export interface TextBlock {
  type: 'text';
  text: string;
  /** 前缀缓存断点标记（Provider 无关；适配器翻译成 cache_control） */
  cacheControl?: 'ephemeral';
}
export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export type ContentBlock = TextBlock | ToolCallBlock;

/**
 * 一条对话消息。
 * - content 可以是纯字符串（最常见），也可以是内容块数组（assistant 同时有文本与 tool_call 时）。
 * - role='tool' 时，用 tool_call_id 关联被调用的工具，name 为工具名。
 */
export interface ChatMessage {
  role: Role;
  content: string | ContentBlock[];
  tool_call_id?: string;
  name?: string;
  /** 重要消息保护：用户显式「记住/重要」等指令标记，压缩时整轮永不折叠/摘要（随会话 JSON 自然持久化） */
  protected?: boolean;
}

/** 模型返回的工具调用（已解析） */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * 工具执行上下文——由 Agent 循环在每次调用工具时注入。
 * 工具应把相对路径解析到 `cwd`，长耗时操作监听 `signal` 以便中断。
 */
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

/**
 * 工具定义。Phase 1 仅用于把 schema 透传给 OpenAI；
 * Phase 2 起补入 `execute` 与并发标记，内置工具与 MCP 工具统一进同一 `ToolRegistry`。
 * inputSchema 采用 JSON Schema 对象（与 OpenAI function calling 对齐）。
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 是否只读——推理用：只读工具可并行执行（Phase 3 执行器据此优化） */
  isReadOnly?: boolean;
  /** 是否破坏性操作（写/删除类）——Phase 3 接 HITL 更严格审批 */
  isDestructive?: boolean;
  /** 前缀缓存断点标记（Provider 无关）；适配器在末个工具上加 cache_control */
  cacheControl?: 'ephemeral';
  /** 工具执行体，由 ToolRegistry 统一调度 */
  execute?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface CompleteOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  /** 流式文本增量回调（仅正式输出，不含推理过程） */
  onText?: (chunk: string) => void;
  /** 流式推理/思考增量回调（reasoning_content / thinking block），默认不展示给用户 */
  onReasoning?: (chunk: string) => void;
  temperature?: number;
  maxTokens?: number;
  /**
   * 前缀缓存意图（Provider 无关）：
   *  - system：在 system 末尾打 cache_control 断点（默认 true）。
   *  - tools ：在末个 tool 上打 cache_control 断点（默认 true）。
   *  - history：在「除当前轮外」的最后一条消息末块打 cache_control 断点，
   *    使 system + tools + 几乎整段历史整体成为可缓存前缀（多轮命中率 60~85%、几乎不衰减）。
   *    默认 false（仅缓存 system+tools，长对话时占比很小）。
   * 设为 undefined 或显式 false 则适配器不加对应标记。
   * 备注：OpenAI 系网关对 ≥1024 token 的前缀自动缓存（无需标记），
   * 本意图对它们主要是 Anthropic 显式断点 + 可观测字段；旧网关忽略未知字段。
   */
  cache?: { system?: boolean; tools?: boolean; history?: boolean };
}

/** 一次模型调用的真实 token 用量（API 在响应里回报；未回报则为 undefined，由上层估算） */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 命中缓存的 input token 数（Anthropic cache_read / OpenAI cached_tokens） */
  cacheReadTokens?: number;
  /** 新建缓存的 input token 数（Anthropic cache_creation，写费略高） */
  cacheCreationTokens?: number;
}

export interface CompleteResult {
  /** 拼接后的完整文本 */
  content: string;
  /** 模型要求调用的工具（若有） */
  toolCalls: ToolCall[];
  /** 原始响应，便于调试 */
  raw?: unknown;
  /** 真实 token 用量；仅当适配器从响应解析到用量时存在（否则由上层估算） */
  usage?: TokenUsage;
}

/** Provider 无关的模型接口——所有适配器都实现它 */
export interface ChatModel {
  /** 例如 "openai:deepseek-chat" */
  readonly id: string;
  complete(opts: CompleteOptions): Promise<CompleteResult>;
}
