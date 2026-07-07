import type { ToolDef } from '../chatmodel/types';
import { RagStore } from './store';

/**
 * RAG 检索工具：让 Agent 在回答前从本地知识库做语义检索，把相关片段补进上下文。
 * 这是「增强生成（Augmented Generation）」的落地点——模型本身不存储知识，
 * 而是在推理时按需检索外部语料并注入。
 * isReadOnly=true → 走执行器「只读并行」分支，且默认权限放行。
 */
export function getRagTools(store: RagStore): ToolDef[] {
  return [
    {
      name: 'rag_search',
      description:
        '在本地已索引的知识库（文档/代码）中做语义检索，返回与 query 最相关的若干段文本及其来源。' +
        '回答用户涉及项目文档、规范、历史决策等问题前，应先检索以补充上下文。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索问题/关键词' },
          k: { type: 'number', description: '返回条数，默认 5' },
        },
        required: ['query'],
      },
      isReadOnly: true,
      isDestructive: false,
      execute: async (args: Record<string, unknown>) => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return { ok: false, output: '缺少参数 query' };
        const k = typeof args.k === 'number' ? args.k : 5;
        const results = store.search(query, k);
        return { ok: true, output: RagStore.toContext(results) };
      },
    },
  ];
}
