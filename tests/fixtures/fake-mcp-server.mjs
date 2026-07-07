// 最小可用的 MCP 服务器（stdio + JSON-RPC 2.0），仅用于测试 McpClient。
// 实现 initialize / tools/list / tools/call，并对 shutdown/exit 做响应。
import { strict as assert } from 'node:assert';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(m) {
  process.stdout.write(JSON.stringify(m) + '\n');
}

function handle(msg) {
  // 通知（无 id）：initialized / exit 等
  if (msg.id === undefined) {
    if (msg.method === 'exit') process.exit(0);
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'mcp_echo',
            description: '回显文本',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
          {
            name: 'mcp_add',
            description: '两数相加',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {};
    let out;
    if (name === 'mcp_echo') out = `echo: ${args?.text ?? ''}`;
    else if (name === 'mcp_add') out = `sum: ${Number(args?.a) + Number(args?.b)}`;
    else if (name === 'mcp_fail') {
      // MCP 层「执行成功但业务报错」：用 isError 标记，区别于 JSON-RPC 协议错误
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: '故意失败' }], isError: true },
      });
      return;
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未知工具: ${name}` } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: out }], isError: false },
    });
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `方法不支持: ${msg.method}` } });
  }
}
