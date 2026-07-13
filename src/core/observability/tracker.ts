import type { AgentEvent, EventBus } from '../events/bus';
import { costFor } from './pricing';

/** 一条用量记录的归一化形态（真实或估算，统一成这个结构供累加） */
export interface TokenUsageRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 成本（USD），由 pricing 模块计算 */
  cost: number;
  /** 是否为估算值（API 未回报真实用量时为 true） */
  estimated: boolean;
}

/** 累计/单轮快照：所有指标都从 0 起累加 */
export interface TrackerSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 累计成本（USD） */
  cost: number;
  /** model.complete 调用次数 */
  calls: number;
  /** 上下文压缩触发次数 */
  compressions: number;
  /** 压缩节省的 token（before - after 之和） */
  tokensSavedByCompact: number;
  /** RAG 检索次数（由 tool:result 中 rag_search 推导） */
  retrievals: number;
  /** 快照是否包含估算值（任一记录为估算则整体标记） */
  estimated: boolean;
}

function zero(): TrackerSnapshot {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    calls: 0,
    compressions: 0,
    tokensSavedByCompact: 0,
    retrievals: 0,
    estimated: false,
  };
}

/**
 * 成本/用量追踪器（Phase 14，决策 9 的事件总线挂载点）。
 *
 * 设计要点：
 * - **只订阅、不主动轮询**：挂在 EventBus 上，监听 `token` / `compact` / `tool:result`，
 *   与 Agent 循环完全解耦；审计日志（AuditLogger）是同一套机制的另一个订阅者。
 * - **双视图**：同时维护「累计」与「单轮」两份快照。REPL 每轮 beginTurn→runAgent→endTurn，
 *   得到本轮用量；session 全程用 cumulative 得到总成本。
 * - **真实优先、估算兜底**：`token` 事件若带真实 usage（estimated=false）即用真实值；
 *   否则用轻量估算（见 tokenizer）。快照.estimated 标记是否混入了估算值，供 UI 提示。
 */
export class CostTracker {
  private cumulative: TrackerSnapshot = zero();
  private turn: TrackerSnapshot = zero();

  /** 订阅事件总线，开始自动累加（幂等：重复 attach 会重复监听，谨慎调用） */
  attach(bus: EventBus): void {
    bus.on('token', (e) => this.onToken(e));
    bus.on('compact', (e) => this.onCompact(e));
    bus.on('tool:result', (e) => this.onToolResult(e));
  }

  private onToken(e: AgentEvent): void {
    const model = String(e.model ?? '');
    const promptTokens = Number(e.promptTokens ?? 0);
    const completionTokens = Number(e.completionTokens ?? 0);
    const totalTokens = Number(e.totalTokens ?? promptTokens + completionTokens);
    const estimated = Boolean(e.estimated);
    const rec: TokenUsageRecord = {
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      cost: costFor(model, promptTokens, completionTokens),
      estimated,
    };
    this.add(this.cumulative, rec);
    this.add(this.turn, rec);
  }

  private onCompact(e: AgentEvent): void {
    const before = Number(e.before ?? 0);
    const after = Number(e.after ?? 0);
    const saved = Math.max(0, before - after);
    this.cumulative.compressions += 1;
    this.cumulative.tokensSavedByCompact += saved;
    this.turn.compressions += 1;
    this.turn.tokensSavedByCompact += saved;
  }

  private onToolResult(e: AgentEvent): void {
    // 检索事件汇总：RAG 检索工具名约定为 rag_search（见 core/rag/tools）
    const call = e.call as { name?: string } | undefined;
    if (call?.name === 'rag_search') {
      this.cumulative.retrievals += 1;
      this.turn.retrievals += 1;
    }
  }

  private add(s: TrackerSnapshot, rec: TokenUsageRecord): void {
    s.promptTokens += rec.promptTokens;
    s.completionTokens += rec.completionTokens;
    s.totalTokens += rec.totalTokens;
    s.cost += rec.cost;
    s.calls += 1;
    s.estimated = s.estimated || rec.estimated;
  }

  /** 开始新一轮：清空单轮快照（累计快照不动） */
  beginTurn(): void {
    this.turn = zero();
  }

  /** 读取并拷贝单轮快照 */
  endTurn(): TrackerSnapshot {
    return { ...this.turn };
  }

  /** 读取并拷贝累计快照 */
  snapshot(): TrackerSnapshot {
    return { ...this.cumulative };
  }

  /** 复位：累计与单轮都清零 */
  reset(): void {
    this.cumulative = zero();
    this.turn = zero();
  }
}

/**
 * 把 token 数格式化为紧凑串：
 * - < 10000：带千分位（如 9999 → "9,999"）；
 * - ≥ 10000：用 k 单位，整数不带小数（10000 → "10k"），非整数保留 1 位（23200 → "23.2k"）。
 */
export function formatTokens(n: number): string {
  const v = Math.round(n);
  if (v >= 10000) {
    const k = v / 1000;
    const s = Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1);
    return `${s}k`;
  }
  return v.toLocaleString('en-US');
}

/**
 * 把快照渲染成单行可读摘要（纯文本、无着色，UI 层自行上色）。
 * 例：`~12,340 tok (估算) | 累计 ~45,678 tok (含估算)`
 */
export function formatSnapshot(turn: TrackerSnapshot, cumulative?: TrackerSnapshot): string {
  const parts: string[] = [];
  const tEst = turn.estimated ? ' (估算)' : '';
  parts.push(
    `本轮 ~${formatTokens(turn.totalTokens)} tok${tEst}`,
  );
  if (cumulative) {
    const cEst = cumulative.estimated ? ' (含估算)' : '';
    parts.push(
      `累计 ~${formatTokens(cumulative.totalTokens)} tok${cEst}`,
    );
  }
  let line = parts.join(' | ');
  // 附加事件汇总（有才显示，避免噪音）
  const extras: string[] = [];
  if (cumulative?.compressions)
    extras.push(`压缩 ${cumulative.compressions} 次省 ~${formatTokens(cumulative.tokensSavedByCompact)} tok`);
  if (cumulative?.retrievals) extras.push(`检索 ${cumulative.retrievals} 次`);
  if (extras.length) line += `  ·  ${extras.join(' · ')}`;
  return line;
}
