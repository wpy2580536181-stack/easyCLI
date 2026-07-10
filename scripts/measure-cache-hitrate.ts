/**
 * 前缀缓存命中率实测（离线、用真实代码路径）。
 *
 * 结论演进：
 *  - P0「稳定前缀」让 system+tools 逐字节稳定，但当前只有 ~693 token < 1024 门槛，
 *    单独靠它命中率恒为 ~0%。
 *  - ②「历史稳定段缓存」(cache.history) 在「当前轮之前」最后一条消息末块打点，
 *    使可缓存前缀 = system+tools+几乎整段历史。即使 system+tools 只有 693，
 *    第 2 轮起前缀也因历史越过 1024 → 命中率跳到 60~95% 且几乎不衰减。
 *
 * 本脚本用项目真实的 buildAgentSystemPrompt / getBuiltinTools / estimateTokens 算出真实前缀，
 * 并模拟 realistic 多轮对话，给出「开启 history 断点」后的真实命中率曲线。
 */
import { buildAgentSystemPrompt } from '../src/core/prompts/index';
import { getBuiltinTools } from '../src/core/tools/builtin';
import { estimateTokens, estimateMessagesTokens } from '../src/core/observability/tokenizer';
import type { ChatMessage, ToolDef } from '../src/core/chatmodel/types';

const MIN_CACHE = 1024; // 网关缓存前缀最小 token 数

function toolTokens(tool: ToolDef): number {
  return estimateTokens(
    JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }),
  );
}

function realPrefix(): { sys: number; tools: number; prefix: number } {
  const tools = getBuiltinTools().sort((a, b) => a.name.localeCompare(b.name));
  const sysCtx = { cwd: process.cwd(), toolNames: tools.map((t) => t.name), now: new Date() };
  const sys = estimateTokens(buildAgentSystemPrompt(sysCtx));
  const toolsTok = tools.reduce((s, t) => s + toolTokens(t), 0);
  return { sys, tools: toolsTok, prefix: sys + 3 + toolsTok };
}

/** 模拟 realistic 单人多轮开发会话，返回每轮累计总 token（含前缀） */
function simConversation(turnCount: number) {
  const perTurnUser = 220;
  const perTurnAssistant = 900;
  const perTurnTool = 1400;
  const perTurnToolCalls = 2;
  const history: ChatMessage[] = [{ role: 'system', content: 'x'.repeat(287) }];
  const rows: Array<{ turn: number; total: number }> = [];
  for (let turn = 1; turn <= turnCount; turn++) {
    history.push({ role: 'user', content: 'u'.repeat(perTurnUser) });
    for (let i = 0; i < perTurnToolCalls; i++) {
      history.push({
        role: 'assistant',
        content: [{ type: 'tool_call', id: `t${turn}_${i}`, name: 'read_file', arguments: { path: 'src/x.ts' } }],
      });
      history.push({ role: 'tool', tool_call_id: `t${turn}_${i}`, name: 'read_file', content: 'y'.repeat(perTurnTool) });
    }
    history.push({ role: 'assistant', content: 'z'.repeat(perTurnAssistant) });
    rows.push({ turn, total: estimateMessagesTokens(history) });
  }
  return rows;
}

const { sys, tools, prefix } = realPrefix();
console.log('=== 真实可缓存前缀（项目真实代码算出） ===');
console.log(`  system 提示词 : ${sys} tokens`);
console.log(`  工具声明合计 : ${tools} tokens`);
console.log(`  可缓存前缀   : ${prefix} tokens（system+tools，当前会话恒定）`);
console.log(`  网关门槛     : ≥ ${MIN_CACHE} tokens 才建缓存`);
console.log(`  → 仅靠 system+tools：${prefix >= MIN_CACHE ? '可缓存' : '不触发（' + prefix + ' < ' + MIN_CACHE + '），命中率恒定 ~0%'}`);
console.log('');

console.log('=== 开启 history 断点（cache.history）后的真实命中率曲线 ===');
console.log('  cached = system+tools + 除当前轮外的全部历史；第2轮起因历史越过门槛');
const rows = simConversation(20);
console.log('turn |  cached |  total  | 命中率');
console.log('-----+---------+---------+-------------------');
for (let t = 0; t < rows.length; t++) {
  const r = rows[t]!;
  // 第1轮：断点只覆盖 system+tools(=prefix)，低于门槛 → 写入(0%)
  // 第N轮：cached = 前 N-1 轮累计(含前缀) = rows[t-1].total；total = rows[t].total
  const cached = t === 0 ? prefix : rows[t - 1]!.total;
  const hit = t === 0 ? 'WRITE(0%)' : `${Math.round((cached / r.total) * 100)}%`;
  console.log(`${String(r.turn).padStart(4)} | ${String(cached).padStart(7)} | ${String(r.total).padStart(7)} | ${hit}`);
}
console.log('');
console.log('=== 说明 ===');
console.log('  · 第1轮永远是 cache WRITE（新前缀），显示 0% 属正常。');
console.log('  · 第2轮起前缀 = system+tools+第1轮，已 > 1024 → 稳定命中。');
console.log('  · 命中率随对话增长几乎不衰减（cached 与 total 同步增长）——这是 Claude Code 多轮高命中的关键。');
console.log('  · autoContext 每轮不同，已被断点挡在「当前轮」内，不会击穿缓存。');
