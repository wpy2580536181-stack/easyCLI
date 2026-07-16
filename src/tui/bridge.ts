// TUI 桥接层：连接「Agent 循环」与「store」。
//
// 职责（docs/tui-ink-design.md §4.2.8 / §7.2）：
//  1. 流式节流：runAgent 的 onText(c) 累积进 streamBuffer，定时（30ms）一次性
//     commit 到 store.pushText，把「高频 SSE」与「低频 React 渲染」解耦。
//  2. 把 onToolCall / onToolResult 映射为 store actions。
//  3. 暴露 requestApproval（HITL）与 finishTurn 供 repl.ts / 权限层调用。
//
// 本层不 import ink，保证可脱离终端单测。

import type { AppStoreApi } from './store';

export interface BridgeOptions {
  /** flush 节流间隔（毫秒），默认 30ms。 */
  flushMs?: number;
}

export interface Bridge {
  /** runAgent onText 回调：累积 token（不立即渲染）。 */
  pushToken(c: string): void;
  /** runAgent onReasoning 回调：累积推理 token 到独立缓冲（不进 assistantBuffer）。 */
  pushReasoning(c: string): void;
  /** runAgent onToolCall 回调。 */
  onToolCall(name: string): void;
  /** runAgent onToolResult 回调。 */
  onToolResult(name: string, ok: boolean): void;
  /** 开始一轮：思考态动画。 */
  beginTurn(label?: string): void;
  /** 一轮结束：flush 残留 → 落 history → 清缓冲 → idle。 */
  finishTurn(): void;
  /** 立即把累积的 token 缓冲提交到 store（repl 在 endTurn 前读取 assistantBuffer 用）。 */
  flush(): void;
  /** HITL 审批：返回 Promise，由 <Approval> 或 readline 回退 resolve。 */
  requestApproval(question: string, opts?: { debounceMs?: number }): Promise<string>;
  /** 释放定时器（unmount 时调用），并 flush 残留。 */
  dispose(): void;
}

export function createBridge(store: AppStoreApi, opts: BridgeOptions = {}): Bridge {
  const flushMs = opts.flushMs ?? 30;
  let buffer = '';
  let reasoningBuffer = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  const flush = () => {
    if (!buffer) return;
    const chunk = buffer;
    buffer = '';
    store.getState().pushText(chunk);
  };

  const flushReasoning = () => {
    if (!reasoningBuffer) return;
    const chunk = reasoningBuffer;
    reasoningBuffer = '';
    store.getState().pushReasoning(chunk);
  };

  const ensureTimer = () => {
    if (timer) return;
    timer = setInterval(flush, flushMs);
    // 不阻止进程退出
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  };

  return {
    pushToken(c) {
      if (!c) return;
      buffer += c;
      ensureTimer();
    },
    pushReasoning(c) {
      if (!c) return;
      reasoningBuffer += c;
      // 推理内容不触发节流定时器，仅更新动画标签
      store.getState().setAnimLabel('⟡ 深度思考中…');
    },
    onToolCall(name) {
      flush();
      flushReasoning();
      store.getState().toolStart(name);
    },
    onToolResult(name, ok) {
      flush();
      store.getState().toolDone(name, ok);
    },
    beginTurn(label = '') {
      store.getState().beginAnim(label);
    },
    finishTurn() {
      flush();
      flushReasoning();
      store.getState().finishTurn();
    },
    flush() {
      flush();
      flushReasoning();
    },
    requestApproval(question, o) {
      flush();
      return store.getState().requestApproval(question, o);
    },
    dispose() {
      flush();
      flushReasoning();
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
