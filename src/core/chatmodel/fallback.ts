// Phase 11（多模型适配补全）：fallback model 降级装饰器。
//
// 实现 ChatModel 接口的「装饰器」：包装主模型与备用模型。
// 主模型 .complete() 抛错时，自动用备用模型重试一次（决策 10 的「可选 fallback model」）。
//
// 关键正确性细节：
// - 用户中断（AbortError / signal.aborted）**绝不**触发降级——否则会浪费一次请求，
//   且已通过 onText 流式吐出的前半段文本会和备用模型的输出拼在一起，造成重复/错乱。
// - 若备用模型也抛错，异常照常向上冒泡（不吞错）。
// - 通过可选 onSwitch 回调让上层知道「发生了降级」，便于状态栏提示或审计。

import type { ChatModel, CompleteOptions, CompleteResult } from './types';

export interface FallbackOptions {
  /** 主模型失败时回调（如用于日志/状态栏提示） */
  onSwitch?: (primaryId: string, fallbackId: string, error: unknown) => void;
}

export class FallbackChatModel implements ChatModel {
  constructor(
    private readonly primary: ChatModel,
    private readonly fallback: ChatModel,
    private readonly opts: FallbackOptions = {},
  ) {}

  get id(): string {
    return `${this.primary.id}→${this.fallback.id}`;
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    try {
      return await this.primary.complete(opts);
    } catch (err) {
      // 用户主动中断：不降级，直接把中断错误继续向上抛
      if (opts.signal?.aborted || (err as { name?: string })?.name === 'AbortError') {
        throw err;
      }
      this.opts.onSwitch?.(this.primary.id, this.fallback.id, err);
      return await this.fallback.complete(opts);
    }
  }
}
