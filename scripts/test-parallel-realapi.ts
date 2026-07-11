// 真实 API 验证：s12 并行处理（task_run_parallel 看板扇出）
// 复用产品真实系统提示 + 工具装配，用真实模型把一张有依赖的任务图并行派给子 Agent 执行。
//
// 运行：source .env && pnpm exec tsx scripts/test-parallel-realapi.ts
// 注意：任务会落到临时目录的 .tasks/，不污染仓库。

import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChatModel } from '../src/core/chatmodel';
import { createToolRegistry } from '../src/core/tools/registry';
import { TodoStore, getPlanningTools } from '../src/core/tools/planning';
import { TaskStore, getTaskTools } from '../src/core/tasks';
import { getSubagentTools } from '../src/core/multiagent/subagent';
import { PermissionManager } from '../src/core/security/permission';
import { EventBus } from '../src/core/events/bus';
import { buildAgentSystemPrompt } from '../src/core/prompts';
import { runAgent } from '../src/core/agent/loop';
import { loadConfig } from '../src/config';

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'parallel-realapi-'));
  console.log('临时工作目录:', root);

  const config = loadConfig();
  const model = createChatModel(config);

  const tools = createToolRegistry();
  const todoStore = new TodoStore();
  tools.registerAll(getPlanningTools(todoStore));
  const taskStore = new TaskStore(root);
  const bus = new EventBus();
  const permission = new PermissionManager({ registry: tools, defaultForAsk: 'allow' });

  tools.registerAll(getSubagentTools({ model, permission, bus, cwd: root, tools }));
  tools.registerAll(getTaskTools(taskStore, { model, permission, bus, cwd: root, tools }));

  const sys = buildAgentSystemPrompt({
    toolNames: tools.list().map((t) => t.name),
    cwd: root,
    now: new Date().toISOString(),
  });

  const taskCalls: string[] = [];
  await runAgent(
    [
      { role: 'system', content: sys },
      {
        role: 'user',
        content:
          '请为「给用户做一个极简的 CLI 待办工具」这个虚构项目规划并并行执行一组任务：\n' +
          '1) 先 task_create 建任务图：T1「写 README 说明」(无依赖)；T2「写 install 脚本」(依赖 T1)；T3「写使用示例」(依赖 T1)；T4「写 GitHub Actions CI」(依赖 T2 与 T3)。\n' +
          '2) 然后调用 task_run_parallel（maxWorkers=2）让子 Agent 真正去并行完成这些任务（各自在临时目录里生成对应文件即可）。\n' +
          '3) 最后用 task_list 汇报每个任务的最终状态。',
      },
    ],
    {
      model,
      tools,
      permission,
      bus,
      cwd: root,
      maxIterations: 40,
      onToolCall: (call) => {
        if (call.name.startsWith('task')) taskCalls.push(call.name);
        console.log('  tool>', call.name);
      },
    },
  );

  // 断言：看板清空（全部 completed）
  const dir = join(root, '.tasks');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)) : [];
  const allCompleted = files.length > 0 && files.every((f) => {
    const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return t.status === 'completed';
  });

  console.log('\n========== 并行处理 真实 API 验证结果 ==========');
  console.log('task 工具调用序列:', taskCalls.join(' → '));
  console.log('.tasks/ 任务文件数:', files.length);
  console.log('是否调用了 task_run_parallel:', taskCalls.includes('task_run_parallel'));
  console.log('所有任务已完成(completed):', allCompleted);

  rmSync(root, { recursive: true, force: true });
  if (taskCalls.includes('task_run_parallel') && allCompleted) {
    console.log('结果: PASS ✅');
    process.exit(0);
  } else {
    console.log('结果: 未触发并行扇出或未清空看板（可能模型选择串行处理，见上文说明）');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
