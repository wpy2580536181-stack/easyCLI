/**
 * 真实 API 验证（Phase 24 / Task System）：agent 是否能用 task_create 建依赖图、
 * 用 task_claim / task_complete 按 DAG 推进，并把任务持久化到 .tasks/。
 * 复用产品真实系统提示 + 工具装配，用 onToolCall 观测委派与推进。
 */
import { createChatModel } from '../src/core/chatmodel';
import type { AppConfig } from '../src/config';
import { createToolRegistry } from '../src/core/tools/registry';
import { TodoStore, getPlanningTools } from '../src/core/tools/planning';
import { TaskStore, getTaskTools, type Task } from '../src/core/tasks';
import { PermissionManager } from '../src/core/security/permission';
import { runAgent } from '../src/core/agent/loop';
import { buildAgentSystemPrompt } from '../src/core/prompts';
import type { ChatMessage, ToolCall } from '../src/core/chatmodel/types';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// 用临时目录当 cwd：.tasks/ 落在这里，不污染项目仓库（跑完即清）
const cwd = mkdtempSync(join(tmpdir(), 'easycli-tasktest-'));
const taskStore = new TaskStore(cwd);

const model = createChatModel(config);
const tools = createToolRegistry();
const todoStore = new TodoStore();
tools.registerAll(getPlanningTools(todoStore));
tools.registerAll(getTaskTools(taskStore));

const permission = new PermissionManager({ registry: tools, defaultForAsk: 'allow' });
const sys = buildAgentSystemPrompt({ cwd, toolNames: tools.list().map((t) => t.name), now: new Date() });

const prompt =
  '请用「任务系统」工具（task_create / task_claim / task_complete / task_list）来建模并执行下面这个计划，' +
  '并保证任务间的依赖顺序：\n' +
  '1) 搭建数据库表（setup database schema）\n' +
  '2) 编写 API 接口（create API endpoints），它依赖第 1 步\n' +
  '3) 编写测试（write tests），它依赖第 2 步\n' +
  '4) 编写文档（write docs），它依赖第 1 步\n\n' +
  '要求：用 task_create 创建这 4 个任务，并通过 blockedBy 声明上述依赖；' +
  '然后按依赖顺序 task_claim + task_complete 推进（被依赖的任务没完成前不要 claim 后续任务）；' +
  '全部完成后调用 task_list 展示最终状态，并用一两句话说明你做了什么。';

const history: ChatMessage[] = [
  { role: 'system', content: sys },
  { role: 'user', content: prompt },
];

const order: string[] = [];
let round = 0;
let taskCreateCount = 0;
let taskClaimCount = 0;
let taskCompleteCount = 0;

await runAgent(history, {
  model,
  tools,
  permission,
  cwd,
  maxIterations: 40,
  onToolCall: (call: ToolCall) => {
    if (call.name === 'task_create') taskCreateCount++;
    if (call.name === 'task_claim') taskClaimCount++;
    if (call.name === 'task_complete') taskCompleteCount++;
    if (call.name.startsWith('task_')) {
      console.log(`[TOOL r${round}] ${call.name} -> ${JSON.stringify(call.arguments)}`);
    } else {
      console.log(`[TOOL r${round}] ${call.name}`);
    }
    order.push(`r${round}:${call.name}`);
  },
  onText: () => {
    if (round < 40) round++;
  },
});

// 验证 .tasks/ 落盘与 DAG 结构
const tasksDir = join(cwd, '.tasks');
const files = existsSync(tasksDir) ? readdirSync(tasksDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')) : [];
const tasks: Task[] = files.map((f) => JSON.parse(readFileSync(join(tasksDir, f), 'utf8')) as Task);
console.log('\n========== Task System 真实 API 验证结果 ==========');
console.log(`工具调用：task_create=${taskCreateCount}  task_claim=${taskClaimCount}  task_complete=${taskCompleteCount}`);
console.log(`落盘任务文件数：${tasks.length}`);
console.log(`工具调用序列：${order.join('  ')}`);
console.log('--- .tasks/ 内容 ---');
for (const t of tasks.sort((a, b) => Number(a.id) - Number(b.id))) {
  console.log(`  ${t.id} [${t.status}] ${t.subject}  blockedBy=[${t.blockedBy.join(',')}]`);
}

// 断言（结构化：基于 blockedBy 的 id 关系，不依赖任务标题文字）
const roots = tasks.filter((t) => t.blockedBy.length === 0);
const r = roots[0];
const xDependsOnRoot = tasks.find((t) => t.blockedBy.length === 1 && t.blockedBy[0] === r?.id);
const chainLen3 = !!xDependsOnRoot && tasks.some((t) => t.blockedBy.length === 1 && t.blockedBy[0] === xDependsOnRoot.id);
const dependOnRoot = tasks.filter((t) => t.blockedBy[0] === r?.id);
const checks: [string, boolean][] = [
  ['创建了 4 个任务', tasks.length === 4],
  ['恰好一个根任务（无依赖）', roots.length === 1],
  ['存在任务依赖根（r→X）', !!xDependsOnRoot],
  ['存在链式依赖（X→Y，链长 3）', chainLen3],
  ['第二个任务也依赖根（r→Z，分叉）', dependOnRoot.length >= 2],
  ['所有任务已 completed', tasks.every((t) => t.status === 'completed')],
];
console.log('--- 断言 ---');
let allPass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) allPass = false;
}

console.log(`\n结果：${allPass ? 'PASS ✅' : 'FAIL ❌'}`);

rmSync(cwd, { recursive: true, force: true });
process.exit(allPass ? 0 : 1);
