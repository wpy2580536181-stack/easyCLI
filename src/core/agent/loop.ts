import type {
  ChatMessage,
  ChatModel,
  CompleteResult,
  ContentBlock,
  ToolCall,
  ToolDef,
  ToolResult,
} from '../chatmodel/types';
import type { ToolRegistry } from '../tools/registry';
import { executeTools } from '../tools/executor';
import { compressorSystemPrompt } from '../prompts';
import type { PermissionManager } from '../security/permission';
import type { EventBus } from '../events/bus';
import {
  compressHistory,
  estimateHistoryTokens,
  type CompressOptions,
  type Summarizer,
} from '../memory/compressor';

/** Agent 循环对外的钩子：用于渲染器把过程可视化 */
export interface AgentHooks {
  onText?: (chunk: string) => void;
  onToolCall?: (call: ToolCall, tool: ToolDef | undefined) => void;
  onToolResult?: (call: ToolCall, result: ToolResult) => void;
  /** 上下文被压缩时回调（决策 9 的 onCompact 挂载点） */
  onCompact?: (info: { before: number; after: number }) => void;
}

export interface AgentOptions extends AgentHooks {
  model: ChatModel;
  tools: ToolRegistry;
  /** 三级权限（Phase 3 接入）；不提供则全部放行 */
  permission?: PermissionManager;
  /** 事件总线（Phase 3 接入）；提供则审计等订阅者收到事件 */
  bus?: EventBus;
  /** 上下文压缩配置（Phase 4）；提供且超预算时，发给模型的副本会被压缩 */
  compress?: CompressOptions;
  cwd?: string;
  maxIterations?: number;
  signal?: AbortSignal;
}

/** 默认摘要器：用当前模型把中间历史压成中文摘要（无工具，纯文本总结） */
function defaultSummarizer(model: ChatModel): Summarizer {
  return async (text: string) => {
    const r = await model.complete({
      messages: [
        {
          role: 'system',
          content: compressorSystemPrompt(),
        },
        { role: 'user', content: text },
      ],
    });
    return r.content ?? '';
  };
}

/**
 * ReAct 循环：Reasoning → Acting → Observing，直到模型不再请求工具。
 *
 * 不变量：每个 assistant(tool_call) 之后都紧跟对应的 tool 结果消息，
 * 保证历史合法（OpenAI 要求 tool_calls 后必须跟 role:'tool'），
 * 且下一轮模型能看到自己上一轮的工具调用与结果。
 *
 * 工具执行委托给 executeTools（读并行/写串行 + 权限 + 事件），本函数只负责「调模型 + 回填历史」。
 * 直接改写传入的 history（追加 assistant / tool 消息），调用方持有同一引用即可。
 */
export async function runAgent(
  history: ChatMessage[],
  opts: AgentOptions,
): Promise<ChatMessage[]> {
  const maxIter = opts.maxIterations ?? 10;
  const cwd = opts.cwd ?? process.cwd();

  for (let i = 0; i < maxIter; i++) {
    if (opts.signal?.aborted) break;

    // 用户中断（Ctrl+C）时 fetch 会抛 AbortError，需就地消化为「正常停止」，
    // 否则异常会冒泡冲垮 REPL 的事件循环。
    let result: CompleteResult;

    // 上下文超限自动压缩（决策 10 + 决策 7）：压缩「发给模型的副本」，不动规范 history
    let messages: ChatMessage[] = history;
    try {
      if (opts.compress && estimateHistoryTokens(history) > opts.compress.budgetTokens) {
        const summarizer = opts.compress.summarizer ?? defaultSummarizer(opts.model);
        messages = await compressHistory(history, { ...opts.compress, summarizer });
        const before = estimateHistoryTokens(history);
        const after = estimateHistoryTokens(messages);
        opts.bus?.emit({ type: 'compact', before, after });
        opts.onCompact?.({ before, after });
      }
    } catch {
      messages = history; // 压缩失败则退回原文，保证主流程不中断
    }

    try {
      result = await opts.model.complete({
        messages,
        tools: opts.tools.list(),
        signal: opts.signal,
        onText: opts.onText,
      });
    } catch (e) {
      if (opts.signal?.aborted) break;
      throw e;
    }

    // 1) 落 assistant 消息：文本与 tool_call 都存成 ContentBlock[]，
    //    保证下一轮模型能看到自己上一轮的工具调用与参数。
    const blocks: ContentBlock[] = [];
    if (result.content) blocks.push({ type: 'text', text: result.content });
    for (const tc of result.toolCalls) {
      blocks.push({ type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments });
    }
    const hasToolCall = result.toolCalls.length > 0;
    history.push({
      role: 'assistant',
      content: hasToolCall ? blocks : result.content,
    });

    // 2) 没有工具调用 → 最终答案，结束循环
    if (!hasToolCall) break;

    // 3) 执行工具（读并行/写串行 + 权限 + 事件），结果以 role:'tool' 回注历史
    const results = await executeTools(result.toolCalls, {
      registry: opts.tools,
      permission: opts.permission,
      bus: opts.bus,
      cwd,
      signal: opts.signal,
      hooks: { onToolCall: opts.onToolCall, onToolResult: opts.onToolResult },
    });
    for (let k = 0; k < result.toolCalls.length; k++) {
      const tc = result.toolCalls[k]!;
      history.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: results[k]!.output,
      });
    }

    // 4) 已达最大轮次：不再调用模型，避免留下无对应结果的 tool_call（历史合法性）
    if (i === maxIter - 1) break;
  }

  return history;
}
