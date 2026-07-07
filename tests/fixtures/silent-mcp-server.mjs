// 故意「假死」的 MCP 服务端：启动后既不读 stdin 也不写 stdout，
// 仅用于测试 McpClient 在静默服务端上的 initialize 超时行为。
// 进程保持存活（空转定时），直到被父进程 SIGTERM。
setInterval(() => {}, 1_000_000);
