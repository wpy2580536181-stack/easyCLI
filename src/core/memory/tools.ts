import type { ToolContext, ToolDef } from '../chatmodel/types';
import type { MemoryStore } from './store';

/**
 * 长期记忆工具：让 Agent 能把「跨会话该记住的事实」写入 SQLite，并随时召回。
 * 与上下文压缩是两套独立机制（决策 7）：压缩管「本次发给模型的视图」，
 * 记忆管「持久事实」——模型可在回答前先 recall，写完事实后 remember。
 */
export function getMemoryTools(store: MemoryStore): ToolDef[] {
  return [
    {
      name: 'remember',
      description: '把一条值得长期记住的事实写入记忆库（跨会话保留），如用户偏好、项目约定、已做决策。',
      inputSchema: {
        type: 'object',
        properties: { fact: { type: 'string' } },
        required: ['fact'],
      },
      isReadOnly: false,
      isDestructive: false,
      execute: async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
        const fact = typeof args.fact === 'string' ? args.fact.trim() : '';
        if (!fact) return { ok: false, output: '缺少参数 fact' };
        const id = store.remember(fact, 'agent');
        return { ok: true, output: `已记住 (#${id}): ${fact}` };
      },
    },
    {
      name: 'recall',
      description: '从记忆库召回事实。可省略 query 取最近若干条，或传 query 做模糊搜索。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      isReadOnly: true,
      isDestructive: false,
      execute: async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const limit = typeof args.limit === 'number' ? args.limit : 10;
        const rows = query ? store.search(query, limit) : store.recall(limit);
        if (rows.length === 0) return { ok: true, output: '（记忆库为空或无可匹配项）' };
        const text = rows
          .map((r) => {
            const typeTag = r.type && r.type !== 'user' ? `[${r.type}] ` : '';
            const nameTag = r.name ? `${r.name}： ` : '';
            return `#${r.id} [${r.createdAt.slice(0, 10)}] ${typeTag}${nameTag}${r.fact}`;
          })
          .join('\n');
        return { ok: true, output: text };
      },
    },
  ];
}
