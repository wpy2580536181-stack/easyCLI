// 半响应 MCP 服务端：正常完成 initialize / tools/list 握手，
// 但收到 tools/call 后故意「吞掉」不回响应——用于测试 disconnect 时让在途请求立即失败。
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
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // 通知忽略
    if (msg.method === 'initialize') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lazy', version: '1.0.0' } },
        }) + '\n',
      );
    } else if (msg.method === 'tools/list') {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
          { name: 'mcp_echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        ] } }) + '\n',
      );
    } else if (msg.method === 'tools/call') {
      // 故意不响应，模拟服务端卡死
    }
  }
});
