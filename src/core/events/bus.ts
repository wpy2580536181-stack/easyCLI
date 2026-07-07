/** Agent 运行期事件类型，审计/可观测性统一订阅此总线（决策 9） */
export type AgentEventType =
  | 'tool:call'
  | 'tool:result'
  | 'error'
  | 'turn'
  | 'compact'
  | 'token'
  | 'tool:batch';

export interface AgentEvent {
  type: AgentEventType;
  [key: string]: unknown;
}

type Handler = (e: AgentEvent) => void;

/**
 * 极简事件总线：解耦「Agent 循环」与「审计/可观测性」。
 * 循环只负责 emit，审计日志、未来监控都作为独立订阅者挂上，不推翻结构。
 */
export class EventBus {
  private readonly handlers = new Map<AgentEventType, Handler[]>();

  on(type: AgentEventType, handler: Handler): void {
    const arr = this.handlers.get(type) ?? [];
    arr.push(handler);
    this.handlers.set(type, arr);
  }

  emit(event: AgentEvent): void {
    for (const h of this.handlers.get(event.type) ?? []) h(event);
  }
}
