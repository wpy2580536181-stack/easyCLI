import type { ChatMessage } from './types';

/**
 * 计算「历史稳定段」缓存断点的消息索引。
 *
 * 前缀缓存按「前缀匹配」工作：在 messages[idx] 的最后一个内容块上打
 * cache_control，则 messages[0..idx] 整体作为可缓存前缀——只要它逐字节稳定，
 * 后续轮次就能命中。
 *
 * 策略：缓存「除当前轮之外」的全部历史。当前轮 = 最后一条 user 消息（user_N）
 * 及其紧邻、同为 user 的 autoContext（每轮不同，必须落在断点之后，否则击穿缓存）。
 * 因此断点打在「user_N 之前那条消息」——若 user_N 之前紧邻一条 user 消息
 * （即 autoContext），则再退一格，确保 autoContext 也在断点之后。
 *
 * 返回应打 cache_control 的消息索引；历史不足（无稳定前缀）时返回 -1。
 * 调用方（各适配器）据此在「该消息的最后一个内容块」上打 cache_control。
 *
 * 不变式：返回的消息索引处的内容在跨轮之间是「不可变历史」的一部分，
 * 故前缀稳定可命中。当前轮的 user_N / autoContext / 本轮刚生成的回答都在断点之后。
 */
export function historyBreakpointIndex(messages: ChatMessage[]): number {
  // 找最后一条 user 消息（当前轮 prompt）
  let lastUser = -1;
  for (let k = messages.length - 1; k >= 0; k--) {
    if ((messages[k] as ChatMessage).role === 'user') {
      lastUser = k;
      break;
    }
  }
  if (lastUser <= 0) return -1; // 没有任何「当前轮之前」的稳定历史

  // 若最后 user 之前紧邻一条 user 消息（autoContext），把它算作当前轮、再退一格
  const before = messages[lastUser - 1] as ChatMessage | undefined;
  const acIdx = before && before.role === 'user' ? lastUser - 1 : lastUser;
  return acIdx - 1;
}

/** 在「已翻译消息」的最后一个内容块上打 cache_control 断点。
 * 内容可能是字符串（包成 text block 数组）或 block 数组（取末块）。
 * 适配器翻译后的 user/assistant 消息均带 content 字段，故通用。 */
export function markLastContentBlock(msg: { content?: unknown }): void {
  const content = msg.content;
  if (typeof content === 'string') {
    msg.content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (Array.isArray(content) && content.length) {
    const last = content[content.length - 1] as { cache_control?: unknown };
    last.cache_control = { type: 'ephemeral' };
  }
}

