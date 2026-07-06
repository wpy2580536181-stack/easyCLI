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

/** Agent 循环对外的钩子：用于渲染器把过程可视化，也便于审计/可观测性挂载 */
export interface AgentHooks {
  /** 模型流式文本增量 */
  onText?: (chunk: string) => void;
  /** 即将执行某个工具调用 */
  onToolCall?: (call: ToolCall, tool: ToolDef | undefined) => void;
  /** 工具执行完毕 */
  onToolResult?: (call: ToolCall, result: ToolResult) => void;
}

export interface AgentOptions extends AgentHooks {
  model: ChatModel;
  tools: ToolRegistry;
  /** 工具执行的工作目录，默认 process.cwd() */
  cwd?: string;
  /** 最大推理轮次，防止模型死循环，默认 10 */
  maxIterations?: number;
  /** 取消信号（Ctrl+C 中断在途生成与工具执行） */
  signal?: AbortSignal;
}

/**
 * ReAct 循环：Reasoning → Acting → Observing，直到模型不再请求工具。
 *
 * 核心不变量：每个 assistant(tool_call) 之后都紧跟对应的 tool 结果消息，
 * 这样历史始终合法（OpenAI 要求 tool_calls 后必须跟 role:'tool'），
 * 且下一轮模型能看到自己上一轮发出了什么工具调用、拿到了什么结果。
 *
 * 直接改写传入的 `history`（追加 assistant / tool 消息），调用方持有同一引用即可。
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
    // 否则异常会冒泡冲垮 REPL 的 for-await 循环。
    let result: CompleteResult;
    try {
      result = await opts.model.complete({
        messages: history,
        tools: opts.tools.list(),
        signal: opts.signal,
        onText: opts.onText,
      });
    } catch (e) {
      if (opts.signal?.aborted) break;
      throw e;
    }

    // 1) 落 assistant 消息：文本与 tool_call 都存成 ContentBlock，
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

    // 3) 执行每个工具调用，结果以 role:'tool' 回注历史
    for (const tc of result.toolCalls) {
      const tool = opts.tools.get(tc.name);
      opts.onToolCall?.(tc, tool);

      let res: ToolResult;
      if (!tool || !tool.execute) {
        res = { ok: false, output: `未知或未实现工具: ${tc.name}` };
      } else {
        try {
          res = await tool.execute(tc.arguments, { cwd, signal: opts.signal });
        } catch (e) {
          res = { ok: false, output: `工具执行异常: ${(e as Error).message}` };
        }
      }

      opts.onToolResult?.(tc, res);
      history.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: res.output,
      });
    }

    // 4) 已达最大轮次：不再调用模型，避免留下无对应结果的 tool_call（历史合法性）
    if (i === maxIter - 1) break;
  }

  return history;
}
