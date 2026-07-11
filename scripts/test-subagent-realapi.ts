/**
 * 真实 API 验证（Phase 23 / task 工具）：agent 在普通 ReAct 循环里是否「自主」派发子 agent。
 * 复用产品真实系统提示 + 工具装配，用 onToolCall 与事件总线观测 delegation。
 */
import { createChatModel } from '../src/core/chatmodel';
import type { AppConfig } from '../src/config';
import { createToolRegistry } from '../src/core/tools/registry';
import { TodoStore, getPlanningTools } from '../src/core/tools/planning';
import { getSubagentTools } from '../src/core/multiagent/subagent';
import { PermissionManager } from '../src/core/security/permission';
import { EventBus } from '../src/core/events/bus';
import { runAgent } from '../src/core/agent/loop';
import { buildAgentSystemPrompt } from '../src/core/prompts';
import type { ChatMessage, ToolCall } from '../src/core/chatmodel/types';

const config: AppConfig = {
  provider: (process.env.AGENTCLI_PROVIDER ?? 'openai') as AppConfig['provider'],
  llm: {
    baseURL: process.env.AGENTCLI_BASE_URL ?? '',
    apiKey: process.env.AGENTCLI_API_KEY ?? '',
    model: process.env.AGENTCLI_MODEL ?? '',
    stream: true,
  },
  contextWindow: undefined,
} as AppConfig;

if (!config.llm.apiKey || !config.llm.baseURL || !config.llm.model) {
  console.error('[ERR] 缺少真实 API 配置（AGENTCLI_API_KEY/BASE_URL/MODEL）。请先 source .env');
  process.exit(2);
}

const model = createChatModel(config);
const tools = createToolRegistry();
const todoStore = new TodoStore();
tools.registerAll(getPlanningTools(todoStore));
tools.registerAll(getSubagentTools({ model, permission: new PermissionManager({ registry: tools, defaultForAsk: 'allow' }), cwd: process.cwd(), tools }));

const permission = new PermissionManager({ registry: tools, defaultForAsk: 'allow' });
const bus = new EventBus();
bus.on('agent:spawn', (e: any) => console.log(`  [bus] agent:spawn ${e.role}/${e.label}`));
bus.on('agent:done', (e: any) => console.log(`  [bus] agent:done  ${e.role}/${e.label} ok=${e.ok}`));

const cwd = process.cwd();
const sys = buildAgentSystemPrompt({ cwd, toolNames: tools.list().map((t) => t.name), now: new Date() });

const prompt =
  '请完成一个任务：调研 /Users/wang/Documents/easyCLI 这个项目使用的测试框架是什么' +
  '（看 package.json 的 devDependencies 与测试脚本即可），并简要说明。\n' +
  '提示：这个调研是一个相对独立的子任务，如果合适，你可以用 task 工具把它派给一个子 Agent 去完成，' +
  '从而保持主对话上下文干净；最后请把调研结论整合进你的回复。';

const history: ChatMessage[] = [
  { role: 'system', content: sys },
  { role: 'user', content: prompt },
];

const order: string[] = [];
let taskCalled = false;
let taskRound = -1;
let round = 0;

await runAgent(history, {
  model,
  tools,
  permission,
  bus,
  cwd,
  maxIterations: 30,
  onToolCall: (call: ToolCall) => {
    if (call.name === 'task') {
      taskCalled = true;
      taskRound = round;
      console.log(`[TOOL r${round}] task -> ${JSON.stringify(call.arguments)}`);
    } else {
      console.log(`[TOOL r${round}] ${call.name}`);
    }
    order.push(`r${round}:${call.name}`);
  },
  onText: () => {
    if (round < 30) round++;
  },
});

const finalText = history
  .filter((m) => m.role === 'assistant')
  .map((m) => (typeof m.content === 'string' ? m.content : ''))
  .join('\n');

console.log('\n========== 自主 Subagent 验证结果 ==========');
console.log(`agent 自主调用了 task 工具 : ${taskCalled}${taskCalled ? `（约第 ${taskRound} 轮）` : ''}`);
console.log(`工具调用序列             : ${order.join('  ')}`);
console.log('--------------------------------------------');
console.log('agent 最终回复（节选）：');
console.log(finalText.slice(-1200));
