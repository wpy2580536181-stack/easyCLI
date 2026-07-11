// 联网搜索工具外壳（Phase 18）。
//
// 把两个网络工具（web_search / web_fetch）导出为 easyCLI 标准的 ToolDef[]，
// 经由 createToolRegistry 的 registerAll 进同一张表。两个工具均标 isReadOnly:true，
// 执行器会自动并行执行且默认放行（无需权限审批）。
//
// 设计要点：工具 execute(args, ctx) 不持有 AppConfig，故沿用 rag/memory/skill 的
// 「工厂 + 闭包」范式——getWebTools(cfg) 在 main.ts 装配时注入 SearchConfig，
// 内部创建一次 provider 并闭包复用。

import type { ToolContext, ToolDef, ToolResult } from '../../chatmodel/types';
import type { SearchConfig } from '../../../config';
import { classifyFetchError } from '../../chatmodel/errors';
import { createSearchProvider } from './factory';
import { combinedSignal, fetchViaProxy } from './fetch-util';

function ok(output: string): ToolResult {
  return { ok: true, output };
}
function fail(output: string): ToolResult {
  return { ok: false, output };
}

export function getWebTools(cfg: SearchConfig): ToolDef[] {
  const provider = createSearchProvider(cfg);
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const defaultMax = cfg.maxResults ?? 5;

  return [
    {
      name: 'web_search',
      description:
        '联网搜索：给定查询词，返回若干网页的标题、链接与摘要。当问题涉及实时信息、最新事件、你不确定或可能过期的外部知识时，应先调用它检索再据此回答。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          maxResults: { type: 'number', description: '返回结果数（默认 5，受配置上限约束）' },
        },
        required: ['query'],
      },
      isReadOnly: true,
      isDestructive: false,
      async execute(args, ctx) {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return fail('缺少参数 query');
        const maxResults =
          typeof args.maxResults === 'number' && args.maxResults > 0
            ? Math.min(args.maxResults, defaultMax)
            : defaultMax;
        try {
          const results = await provider.search(query, { maxResults, signal: ctx.signal });
          if (results.length === 0) return ok(`未找到关于「${query}」的搜索结果。`);
          return ok(
            results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n'),
          );
        } catch (e) {
          return fail(`搜索失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    {
      name: 'web_fetch',
      description:
        '抓取指定网页的纯文本内容（自动去除 HTML 标签/脚本/样式，过长则截断）。在 web_search 拿到链接、需要网页正文细节时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的网页 URL' },
          maxLength: { type: 'number', description: '截取的最大字符数（默认 10000）' },
        },
        required: ['url'],
      },
      isReadOnly: true,
      isDestructive: false,
      async execute(args, ctx) {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) return fail('缺少参数 url');
        const maxLength =
          typeof args.maxLength === 'number' && args.maxLength > 0 ? args.maxLength : 10_000;
        try {
          const res = await fetchViaProxy(
            url,
            { headers: { 'User-Agent': 'agent-cli/0.1' } },
            combinedSignal(ctx.signal, timeoutMs),
            '网页抓取',
          );
          if (!res.ok) {
            const hint = res.status === 429 ? '（目标站点限流）' : '';
            return fail(`HTTP ${res.status}: ${res.statusText} ${hint}`.trim());
          }
          const contentType = res.headers.get('content-type') ?? '';
          let content = await res.text();
          if (contentType.includes('html')) content = extractTextFromHtml(content);
          if (content.length > maxLength) {
            content = content.slice(0, maxLength) + '\n... [truncated]';
          }
          return ok(content || '(empty page)');
        } catch (e) {
          // 与 web_search 一致：网络/中断/未知错误都经 classifyFetchError 翻译成可读消息，
          // 用户 Ctrl+C 也能拿到友好提示而非原始堆栈。
          return fail(`抓取失败: ${classifyFetchError(e, '网页抓取').message}`);
        }
      },
    },
  ];
}

/** 简易 HTML 文本提取（来自 paicli-ts WebFetchTool） */
function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
