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
import { executeTools, type ToolBatchInfo } from '../tools/executor';
import { compressorSystemPrompt } from '../prompts';
import { estimateMessagesTokens, estimateTokens } from '../observability/tokenizer';
import type { PermissionManager } from '../security/permission';
import type { EventBus } from '../events/bus';
import {
  compressHistory,
  reactiveCompact,
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
  /** 一批工具执行完毕的并发画像（Phase 15 异步并行可观测） */
  onBatch?: (info: ToolBatchInfo) => void;
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
  /**
   * 规划模式（Phase 15）：开启后执行器只放行只读工具、拦截一切写/破坏性操作，
   * 配合 plan 系统提示即可「先只读探测、产出计划、待批准再执行」，与 ReAct 共用同一引擎。
   */
  planMode?: boolean;
  /**
   * 自动上下文（Phase 16）：一段由记忆库/知识库检索得到的文本，
   * 会在**每轮模型调用前**作为临时系统消息注入（不写入 history，下一轮重新检索）。
   * 为空/不提供则不注入。
   */
  autoContext?: string;
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

/** 判断错误是否「上下文超长」（API 返回 413 / prompt_too_long / context length） */
function isPromptTooLong(e: unknown): boolean {
  const err = e as { message?: string; status?: number };
  if (err?.status === 413) return true;
  const msg = err?.message ?? '';
  return /prompt[_\s-]?too[_\s-]?long|context[_\s-]?(length|window|limit)|maximum context|too many tokens/i.test(msg);
}

/**
 * 计算一次模型调用的 token 用量记录：
 * - 适配器回报了真实 usage → 直接用（estimated=false）；
 * - 否则用本地轻量估算（CJK 感知，见 observability/tokenizer）。
 * 返回结构直接作为 `token` 事件载荷发给事件总线。
 */
function computeUsage(
  modelId: string,
  messages: ChatMessage[],
  result: CompleteResult,
): {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
} {
  if (result.usage) {
    return {
      model: modelId,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      estimated: false,
    };
  }
  const promptTokens = estimateMessagesTokens(messages);
  const completionTokens =
    estimateTokens(result.content) +
    result.toolCalls.reduce((s, tc) => s + estimateTokens(JSON.stringify(tc.arguments)), 0);
  return {
    model: modelId,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
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
  // 应急压缩重试上限（prompt_too_long / 413 时 reactive 一回）
  let reactiveRetries = 0;

  for (let i = 0; i < maxIter; i++) {
    if (opts.signal?.aborted) break;

    // 用户中断（Ctrl+C）时 fetch 会抛 AbortError，需就地消化为「正常停止」，
    // 否则异常会冒泡冲垮 REPL 的事件循环。
    let result: CompleteResult;

    // 上下文超限自动压缩（决策 10 + 决策 7）：压缩「发给模型的副本」，不动规范 history。
    // atTurnBoundary 仅本轮首个迭代（= 该用户轮的 turn boundary）为 true，
    // 使 L4 摘要只在边界触发，工具循环中段不摘要、不乱动缓存前缀。
    let messages: ChatMessage[] = history;
    try {
      if (opts.compress && estimateHistoryTokens(history) > opts.compress.budgetTokens) {
        const summarizer = opts.compress.summarizer ?? defaultSummarizer(opts.model);
        messages = await compressHistory(history, {
          ...opts.compress,
          summarizer,
          atTurnBoundary: i === 0,
        });
        const before = estimateHistoryTokens(history);
        const after = estimateHistoryTokens(messages);
        opts.bus?.emit({ type: 'compact', before, after });
        opts.onCompact?.({ before, after });
      }
    } catch {
      messages = history; // 压缩失败则退回原文，保证主流程不中断
    }

    // Phase 16：自动上下文——把检索到的记忆/知识库作为**临时**上下文注入。
    // ⚠ 前缀缓存关键：必须以 user 角色、放在「已缓存前缀（system + tools）之后」，
    // 绝不能作为最前的 system 消息（否则会被并进 Anthropic 的顶层 system 前缀，
    // 每轮 RAG 结果不同 → 前缀失效、缓存命中率归零）。不写入 history，下一轮重新检索。
    if (opts.autoContext) {
      // 复制一份再注入，确保持久 history 不被污染（临时、可重算）。
      // 压缩分支已返回新数组故无需再拷；非压缩分支 messages === history，必须拷。
      if (messages === history) messages = [...history];
      const acMsg: ChatMessage = { role: 'user', content: opts.autoContext };
      let lastUser = -1;
      for (let k = messages.length - 1; k >= 0; k--) {
        if ((messages[k] as ChatMessage).role === 'user') {
          lastUser = k;
          break;
        }
      }
      if (lastUser >= 0) messages.splice(lastUser, 0, acMsg);
      else messages.push(acMsg);
    }

    // 工具顺序固定（按名排序）：工具定义属稳定前缀，顺序变化会令前缀失效、缓存击穿
    const tools = [...opts.tools.list()].sort((a, b) => a.name.localeCompare(b.name));
      // 前缀缓存意图：system 末尾 + 末个 tool 打 cache_control 断点；
      // history:true 再在「除当前轮外」的最后一条消息末块打点，
      // 使 system+tools+几乎整段历史整体成为可缓存前缀（多轮命中率 60~85%、几乎不衰减）。
      const callModel = (msgs: ChatMessage[]) =>
        opts.model.complete({
          messages: msgs,
          tools,
          signal: opts.signal,
          onText: opts.onText,
          cache: { system: true, tools: true, history: true },
        });
      // 单次模型调用（最外层只有一个 try/catch）：
      try {
        result = await callModel(messages);
      } catch (e) {
        // 应急：API 报 prompt_too_long / 413（上下文增长快于压缩触发速度）时，
        // 激进折叠（reactive compact）后重试一次；再失败则按原错误抛出，不无限循环。
        if (isPromptTooLong(e) && reactiveRetries < 1) {
          reactiveRetries++;
          const summarizer = defaultSummarizer(opts.model);
          const rm = reactiveCompact(history, {
            ...(opts.compress ?? { budgetTokens: 8000, keepRecentTurns: 4, maxToolOutputChars: 1500 }),
            summarizer,
          });
          messages = rm;
          const before = estimateHistoryTokens(history);
          const after = estimateHistoryTokens(messages);
          opts.bus?.emit({ type: 'compact', before, after });
          opts.onCompact?.({ before, after });
          try {
            result = await callModel(messages);
          } catch (e2) {
            if (opts.signal?.aborted) break;
            throw e2;
          }
        } else {
          if (opts.signal?.aborted) break;
          throw e;
        }
      }


    // 每轮 token 用量：真实优先（适配器回报），否则本地估算 → 发事件给可观测层（决策 9）
    const usage = computeUsage(opts.model.id, messages, result);
    opts.bus?.emit({ type: 'token', ...usage });
    // 真实用量反校准计数器（若有）：使后续压缩预算更接近模型实际收到的 token 数
    const counter = opts.compress?.counter;
    if (usage.estimated === false && counter && counter.calibrate) {
      const est = estimateHistoryTokens(messages, counter);
      counter.calibrate(usage.promptTokens, est);
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
      planMode: opts.planMode,
      hooks: {
        onToolCall: opts.onToolCall,
        onToolResult: opts.onToolResult,
        onBatch: opts.onBatch,
      },
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
