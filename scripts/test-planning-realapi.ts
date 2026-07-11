/**
 * 真实 API 规划能力端到端验证（Phase 21 / todo_write）。
 * 复用产品真实系统提示与工具装配，仅替换权限为「非交互全放行」，
 * 用 onToolCall 钩子观测 agent 是否「先用 todo_write 规划、再执行」。
 */
import { createChatModel } from '../src/core/chatmodel';
import type { AppConfig } from '../src/config';
import { createToolRegistry } from '../src/core/tools/registry';
import { TodoStore, getPlanningTools, renderTodos } from '../src/core/tools/planning';
import { PermissionManager } from '../src/core/security/permission';
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

// 校验关键密钥
if (!config.llm.apiKey || !config.llm.baseURL || !config.llm.model) {
  console.error('[ERR] 缺少真实 API 配置（AGENTCLI_API_KEY/BASE_URL/MODEL）。请先 source .env');
  process.exit(2);
}

const model = createChatModel(config);
const tools = createToolRegistry();
const todoStore = new TodoStore();
tools.registerAll(getPlanningTools(todoStore));

// 非交互脚本：默认 ask→allow，避免 HITL 阻塞（任务本身只读，安全）
const permission = new PermissionManager({ registry: tools, defaultForAsk: 'allow' });
permission.load();

const cwd = process.cwd();
const sys = buildAgentSystemPrompt({
  cwd,
  toolNames: tools.list().map((t) => t.name),
  now: new Date(),
});

const prompt =
  '请在当前项目（/Users/wang/Documents/easyCLI）里完成一个多步探索任务，并直接把结果写在你的回复中（不要写文件）：\n' +
  '1) 列出 src/core/agent 目录下的所有文件；\n' +
  '2) 统计其中 .ts 文件的数量；\n' +
  '3) 找出哪些文件导出了 runAgent 或 runOnce；\n' +
  '4) 把以上发现整理成一份简短的中文报告。\n' +
  '注意：这是一个需要多步完成的任务，请先规划再执行。';

const history: ChatMessage[] = [
  { role: 'system', content: sys },
  { role: 'user', content: prompt },
];

// 观测：记录每次工具调用的顺序与轮次
const order: { round: number; name: string; args: unknown }[] = [];
let round = 0;
let todoWriteCalls = 0;
let firstTodoWriteRound: number | null = null;
let firstExecRound: number | null = null;

await runAgent(history, {
  model,
  tools,
  permission,
  cwd,
  maxIterations: 30,
  todoReminderEveryRounds: 3,
  onToolCall: (call: ToolCall) => {
    if (call.name === 'todo_write') {
      todoWriteCalls++;
      if (firstTodoWriteRound === null) firstTodoWriteRound = round;
    } else if (firstExecRound === null) {
      firstExecRound = round;
    }
    order.push({ round, name: call.name, args: call.arguments });
    console.log(`[TOOL r${round}] ${call.name}`);
  },
  onText: (chunk: string) => {
    // 仅在有实质文本时推进轮次计数（粗略）
    if (chunk && round < 30) round++;
  },
});

const finalTodos = todoStore.list();
const doneCount = finalTodos.filter((t) => t.status === 'completed').length;
const inProg = finalTodos.filter((t) => t.status === 'in_progress').length;
const pending = finalTodos.filter((t) => t.status === 'pending').length;

const finalText = history
  .filter((m) => m.role === 'assistant')
  .map((m) => (typeof m.content === 'string' ? m.content : ''))
  .join('\n')
  .slice(-1500);

console.log('\n========== 规划能力验证结果 ==========');
console.log(`todo_write 调用次数      : ${todoWriteCalls}`);
console.log(`首次规划所在轮次(round)  : ${firstTodoWriteRound}`);
console.log(`首次执行工具所在轮次     : ${firstExecRound}`);
console.log(`规划是否先于执行         : ${firstTodoWriteRound !== null && (firstExecRound === null || firstTodoWriteRound <= firstExecRound)}`);
console.log(`任务清单最终状态         : ${doneCount} 完成 / ${inProg} 进行中 / ${pending} 待办 （共 ${finalTodos.length}）`);
console.log('---------------------------------------');
console.log('最终任务清单：');
console.log(renderTodos(finalTodos));
console.log('---------------------------------------');
console.log('工具调用序列（前 20 个）：');
console.log(order.slice(0, 20).map((o) => `  r${o.round}: ${o.name}`).join('\n'));
console.log('---------------------------------------');
console.log('agent 最终回复（节选）：');
console.log(finalText);
