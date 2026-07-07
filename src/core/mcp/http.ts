// Phase 12：MCP Streamable HTTP 传输层（手写，仅依赖 node:http，不引 express）。
//
// 这是 2024-11-05 协议新增的传输方式，替代旧的 SSE+POST 双端点。
// 约定（本学习实现的子集）：
// 1. 唯一入口 POST /mcp，请求体是单条或批量的 JSON-RPC 消息（application/json）。
// 2. 会话：initialize 时服务端生成 Mcp-Session-Id 并回在响应头；后续请求必须带该头，
//    否则 400（未初始化会话）。会话用于把「多路 HTTP 请求」归并到「一条逻辑连接」。
// 3. 响应：本实现以 application/json 直接返回（退化形态）。完整的 Streamable HTTP
//    还要求支持 text/event-stream（SSE 流式 + 服务端主动推送），留作后续进阶练习。
// 4. GET /mcp（建立 SSE 监听流）与 DELETE /mcp（主动关闭会话）不在本阶段实现。

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpServer, JsonRpcRequest, JsonRpcResponse } from './server';
import { JsonRpcError } from './server';

export interface HttpTransportOptions {
  server: McpServer;
  port?: number;
  host?: string;
}

/** Streamable HTTP 传输：监听 POST /mcp，按会话分发 JSON-RPC。 */
export class HttpTransport {
  private httpServer?: http.Server;
  private readonly server: McpServer;
  private readonly port: number;
  private readonly host: string;
  /** 活跃会话集合：initialize 时写入，DELETE 时移除 */
  private readonly sessions = new Set<string>();

  constructor(opts: HttpTransportOptions) {
    this.server = opts.server;
    this.port = opts.port ?? 3000;
    this.host = opts.host ?? '127.0.0.1';
  }

  /** 启动 HTTP 服务，resolve 实际监听端口（port=0 时由系统分配） */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const httpServer = http.createServer((req, res) => void this.onRequest(req, res));
      httpServer.on('error', reject);
      httpServer.listen(this.port, this.host, () => {
        this.httpServer = httpServer;
        const addr = httpServer.address();
        const bound = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve(bound);
      });
    });
  }

  async close(): Promise<void> {
    if (!this.httpServer) return;
    const s = this.httpServer;
    this.httpServer = undefined;
    this.sessions.clear();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async onRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || path !== '/mcp') {
      res.writeHead(405, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: 'Method Not Allowed，仅支持 POST /mcp' }),
      );
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, jsonHeaders()).end(JSON.stringify({ error: '读取请求体失败' }));
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, jsonHeaders()).end(
        jsonRpcError(null, JsonRpcError.ParseError, '请求体不是合法 JSON'),
      );
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const isBatch = Array.isArray(msg);
    const requests = (isBatch ? (msg as JsonRpcRequest[]) : [msg as JsonRpcRequest]);

    // 是否包含 initialize（批里任一为 initialize 即视为握手请求）
    const hasInit = requests.some((m) => m && m.method === 'initialize');

    // 会话校验：非 initialize 请求必须携带已存在的会话 id
    if (!hasInit) {
      if (typeof sessionId !== 'string' || !this.sessions.has(sessionId)) {
        res.writeHead(400, jsonHeaders()).end(
          JSON.stringify({ error: '缺少或未授权的 Mcp-Session-Id' }),
        );
        return;
      }
    }

    // 逐条 dispatch；通知（id 为空）不进响应数组
    const responses: JsonRpcResponse[] = [];
    let createdSession: string | undefined;
    for (const m of requests) {
      if (!m || typeof m !== 'object') continue;
      if (m.method === 'initialize') {
        createdSession = randomUUID();
        this.sessions.add(createdSession);
      }
      const resp = await this.server.handleMessage(m);
      if (resp) responses.push(resp);
    }

    const headers = jsonHeaders();
    if (createdSession) headers['Mcp-Session-Id'] = createdSession;
    res.writeHead(200, headers).end(JSON.stringify(isBatch ? responses : responses[0]));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
}

function jsonRpcError(
  id: number | string | null,
  code: number,
  message: string,
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}
