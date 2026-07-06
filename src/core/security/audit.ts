import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentEvent, EventBus } from '../events/bus';

/** 脱敏：把密钥/Token 替换成前缀+***，避免审计日志泄露凭据 */
export function redact(text: string): string {
  return text.replace(
    /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]+|api[_-]?key["'\s:=]+[A-Za-z0-9]{8,})/gi,
    (m) => m.slice(0, 4) + '***',
  );
}

/**
 * 审计日志：订阅 EventBus 的 tool:call / tool:result / error 事件，
 * 把每次工具调用与结果以 JSONL 落盘（带脱敏），危险操作可追溯。
 * 写入失败不影响主流程（catch 静默）。
 */
export class AuditLogger {
  constructor(private readonly path: string) {}

  attach(bus: EventBus): void {
    bus.on('tool:call', (e) => this.write('call', e));
    bus.on('tool:result', (e) => this.write('result', e));
    bus.on('error', (e) => this.write('error', e));
  }

  private write(kind: string, e: AgentEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const call = e as { call?: { name?: string; arguments?: unknown } };
      const result = e as { result?: { ok?: boolean; output?: string } };
      // 入参 args 只在 call 行记录一次；result/error 行只记结论，避免冗余与体积膨胀
      const entry =
        kind === 'result'
          ? {
              ts: new Date().toISOString(),
              kind,
              tool: call.call?.name,
              ok: result.result?.ok,
              output: result.result ? redact(String(result.result.output ?? '')) : undefined,
            }
          : kind === 'error'
            ? {
                ts: new Date().toISOString(),
                kind,
                tool: call.call?.name,
                output: result.result ? redact(String(result.result.output ?? '')) : undefined,
              }
            : {
                ts: new Date().toISOString(),
                kind,
                tool: call.call?.name,
                args: redact(JSON.stringify(call.call?.arguments ?? {})),
              };
      appendFileSync(this.path, JSON.stringify(entry) + '\n');
    } catch {
      // 审计写入失败不应影响主流程
    }
  }
}
