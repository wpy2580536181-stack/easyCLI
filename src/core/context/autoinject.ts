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

import type { ChatMessage, ChatModel } from '../chatmodel/types';
import type { MemoryStore, MemoryRecord } from '../memory/store';
import { RagStore } from '../rag/store';

/** 注入所需的检索源（都可缺，缺则跳过对应检索） */
export interface AutoContextSources {
  memory?: MemoryStore | null;
  ragStore?: RagStore | null;
  /**
   * Phase 20：语义召回所需的模型。提供且开启语义召回时，把记忆清单发给模型做 side-query
   * 选 topN，而非字面 LIKE 匹配（理解「部署流程」与「CI/CD 注意事项」这类语义相关但字面不同的表达）。
   */
  model?: ChatModel | null;
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
  /**
   * Phase 20：是否启用 LLM 语义召回。默认：提供 model 即启用。
   * 关闭则回退到现有关键词 LIKE 检索。
   */
  semanticRecall?: boolean;
}

/**
 * 把模型输出里尽可能稳健地抽出整数数组（容忍 markdown 围栏与多余文字），
 * 用于解析语义召回返回的索引列表。
 */
function safeParseIntArray(text: string): number[] {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)).map(Number) : [];
  } catch {
    return [];
  }
}

/**
 * Phase 20 · LLM 语义召回（对齐 s09 select_relevant_memories）。
 * 把候选记忆清单（轻量：name+description）发给模型，由模型按 query 选出真正相关的若干条，
 * 返回其索引（对应 candidates 数组下标）。候选数 ≤ max 时调用方应直接全给、不调本函数。
 * 解析失败抛错，由调用方降级到关键词检索。
 */
export async function selectRelevantMemories(
  query: string,
  candidates: Pick<MemoryRecord, 'id' | 'name' | 'description'>[],
  model: ChatModel,
  max = 5,
): Promise<number[]> {
  const catalog = candidates
    .map((c, i) => `${i}: ${c.name || '(无名)'} — ${c.description || ''}`)
    .join('\n');
  const r = await model.complete({
    messages: [
      {
        role: 'user',
        content:
          `根据下面的「最近查询」选出真正相关的记忆（最多 ${max} 个）。不确定就不要选。\n` +
          '只返回 JSON 数组，如 [0,3,7]，不要输出任何解释文字。\n\n' +
          `最近查询：\n${query}\n\n记忆清单：\n${catalog}`,
      },
    ],
  });
  const idx = safeParseIntArray(r.content ?? '');
  return idx.filter((i) => i >= 0 && i < candidates.length).map((i) => candidates[i]!.id);
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
    const limit = opts.memoryLimit ?? 8;
    let mem = q ? sources.memory.search(q, limit) : sources.memory.recall(limit);

    // Phase 20：语义召回（side-query）——给定 model 且开启时，用 LLM 从候选清单里选 topN，
    // 理解语义相关但字面不同的表达。失败必降级到上面已经算好的关键词结果，绝不影响主对话。
    // 门控：过短 query（<4 字）信号不足、关键词 LIKE 已足够，直接走关键词（按字符数判定，
    // 避免「按空格分词」对中文失效——中文整句无空格会被误判为「单词」）。
    const richQuery = q.length >= 4;
    const useSemantic = (opts.semanticRecall ?? true) && !!sources.model && !!q && richQuery;
    if (useSemantic) {
      try {
        const pool = sources.memory.listAll(limit * 4);
        if (pool.length > limit) {
          const ids = await selectRelevantMemories(q, pool, sources.model!, limit);
          if (ids.length > 0) {
            const picked = sources.memory.getByIds(ids);
            if (picked.length > 0) mem = picked;
          }
        }
      } catch {
        // 降级保留关键词检索结果（上面的 mem 已是 search/recall 结果）
      }
    }

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
