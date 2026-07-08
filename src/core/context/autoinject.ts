// Phase 16：记忆与检索的「自动上下文注入」。
//
// 核心动机：Phase 4 的长期记忆与 Phase 6 的 RAG，此前都靠模型「主动调工具」
// （recall / rag_search）才能进入上下文。本期让 Agent 在每一轮**自动**把相关记忆
// 与知识库片段检索出来、拼成一条系统消息注入，模型无需主动调工具即可「带着上下文思考」，
// 提升「上下文智能化」——这正是 Production RAG Agent 的常见做法（主动检索 → 注入）。
//
// 设计要点：
// - 检索发生在「每轮、基于最新用户输入」；结果作为**临时**系统消息注入，不写进 history，
//   因此下一轮会重新检索、不会在持久历史里累积/污染。
// - 注入点统一在 Agent 引擎（runAgent）：执行器/工具层完全无感知，保持解耦。

import type { ChatMessage } from '../chatmodel/types';
import type { MemoryStore } from '../memory/store';
import { RagStore } from '../rag/store';

/** 注入所需的检索源（都可缺，缺则跳过对应检索） */
export interface AutoContextSources {
  memory?: MemoryStore | null;
  ragStore?: RagStore | null;
}

/** 一次自动检索的结果：拼接好的文本 + 命中计数（供 UI/可观测展示） */
export interface AutoContextResult {
  /** 注入用的完整上下文文本；空串表示无可用内容（调用方据此不注入） */
  text: string;
  memoryCount: number;
  ragCount: number;
}

export interface AutoContextOptions {
  memoryLimit?: number;
  ragK?: number;
}

const HEADER = '【自动上下文 · 由记忆库/知识库检索得到，仅供参考、无需复述】';

/**
 * 根据 query 从记忆库与知识库检索，拼成一条可注入的系统消息文本。
 * - 记忆：有 query 则模糊搜索（search），否则取最近若干条（recall）；
 * - 知识库：query 非空才检索（空 query 的语义检索无意义，直接跳过）；
 * - 两者都为空时返回空串，调用方据此决定「本轮不注入」。
 */
export async function buildAutoContext(
  query: string,
  sources: AutoContextSources,
  opts: AutoContextOptions = {},
): Promise<AutoContextResult> {
  const q = query.trim();
  const parts: string[] = [];
  let memoryCount = 0;
  let ragCount = 0;

  if (sources.memory) {
    const mem = q
      ? sources.memory.search(q, opts.memoryLimit ?? 8)
      : sources.memory.recall(opts.memoryLimit ?? 8);
    if (mem.length > 0) {
      memoryCount = mem.length;
      parts.push(
        '◆ 长期记忆（相关事实）：\n' +
          mem.map((r) => `- #${r.id} [${r.createdAt.slice(0, 10)}] ${r.fact}`).join('\n'),
      );
    }
  }

  if (sources.ragStore && q) {
    const rag = await sources.ragStore.search(q, opts.ragK ?? 5);
    if (rag.length > 0) {
      ragCount = rag.length;
      parts.push('◆ 知识库检索（相关片段）：\n' + RagStore.toContext(rag));
    }
  }

  if (parts.length === 0) return { text: '', memoryCount: 0, ragCount: 0 };
  return { text: `${HEADER}\n\n${parts.join('\n\n')}`, memoryCount, ragCount };
}

/** 取 history 中最近一条 user 消息的纯文本，作为自动检索的 query（Phase 16） */
export function lastUserText(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === 'user') {
      return typeof m.content === 'string' ? m.content : '';
    }
  }
  return '';
}
