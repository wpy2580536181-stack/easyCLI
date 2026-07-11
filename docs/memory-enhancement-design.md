# 记忆系统增强设计方案（自动提取 + LLM 语义召回）

> 状态：**设计待评审（尚未实现）**。对标教程 mini-claude 第 8 章、Learn Claude Code s09。
> 定位：对第 4 期（长期记忆 SQLite）+ 第 16 期（自动上下文注入）的增强，不重排路线图。
> 两项功能相互独立，可分别落地；建议先做①（价值最高），再做②。

---

## 0. 背景与目标

现状（见 `src/core/memory/`、`src/core/context/autoinject.ts`）：
- 记忆**只有显式 `remember` 才写入**——质量取决于模型「想不想记」。
- 记忆召回**只有关键词 `LIKE` 模糊搜索**——无法关联「部署流程」与「CI/CD 注意事项」这类语义相关但字面不同的表述。

教程 s09 的精髓正是补齐这两点：
- **功能①ADD 自动提取**：每轮结束从对话里被动浮现稳定偏好，无需用户说「记住」。
- **功能②ADD LLM 语义召回**：把记忆清单发模型做 side-query 选 top5，而非字面匹配。

目标：在**不破坏现有正交架构、不破坏 P0 前缀缓存、失败不阻断主流程**的前提下落地这两项。

---

## 1. 前置改动（两功能共用）

### 1.1 存储 schema 扩展（`src/core/memory/store.ts`）

当前表：`memory(id, fact, source, created_at)`。教程用 `name/description/type/body` 四字段。折中方案——**加 3 列，保持向后兼容**：

```sql
-- 现有：id, fact(=body 正文), source, created_at
name        TEXT DEFAULT ''          -- 记忆短标题（去重键、召回清单展示）
description TEXT DEFAULT ''          -- 一句话描述（召回清单展示，省 token）
type        TEXT DEFAULT 'user'      -- user | feedback | project | reference
-- source 复用为来源标记：'user'(显式) | 'agent'(工具) | 'auto'(自动提取)
```

迁移策略（幂等，构造函数内执行）：
```ts
// 读 PRAGMA table_info(memory)，缺列才 ALTER TABLE ADD COLUMN。
// SQLite ALTER ADD COLUMN 是 O(1) 元数据操作，安全。
const cols = this.db.prepare('PRAGMA table_info(memory)').all() as { name: string }[];
const has = (c: string) => cols.some((x) => x.name === c);
if (!has('name')) this.db.exec("ALTER TABLE memory ADD COLUMN name TEXT DEFAULT ''");
if (!has('description')) this.db.exec("ALTER TABLE memory ADD COLUMN description TEXT DEFAULT ''");
if (!has('type')) this.db.exec("ALTER TABLE memory ADD COLUMN type TEXT DEFAULT 'user'");
```

新增/调整方法：
```ts
export interface MemoryRecord {
  id: number; fact: string; source: string; createdAt: string;
  name?: string; description?: string; type?: string;   // 新增（可选，兼容旧行）
}

// remember 增加可选结构化字段（旧调用 remember(fact) 仍可用）
remember(fact: string, source?, meta?: { name?: string; description?: string; type?: string }): number

// 新增：取全部（供提取去重 + 语义召回清单），只取轻量字段
listAll(limit = 200): Pick<MemoryRecord, 'id'|'name'|'description'|'type'>[]
```

### 1.2 让记忆层能拿到「模型」

两功能都要调模型做 side-query。现在 `MemoryStore`/`autoinject` 都没有模型引用。**不把模型塞进 store**（保持 store 纯数据），而是：
- 功能②：给 `buildAutoContext` 的 `sources` 增加可选 `model?: ChatModel`。
- 功能①：`extractor.ts` 显式接收 `model` 参数。

---

## 2. 功能①：自动提取（extractMemories）

### 2.1 定位与交付物
- 新模块 `src/core/memory/extractor.ts`。
- 挂载点：`src/cli/repl.ts` 回合结束 `if (!turnError) { void persistAutosave(); ... }` 处，**与 autosave 并列，fire-and-forget（`void`，不 await）**。
- 单次模式（`repl.ts` 顶部 `runOnce` 分支，第 111–127 行附近）同样可挂，但单次模式生命周期短、价值低，**首版只在 REPL 交互模式挂**。

### 2.2 触发时机与门控（对齐 s09）
教程条件：`stop_reason != "tool_use"`（对话告一段落）。easyCLI 的 `runAgent` **返回即等价于「本轮无更多 tool_call」**，所以「runAgent 返回后」就是正确时机。额外门控（任一不满足则跳过，省钱）：

1. **来源门控**：本轮主 Agent 若已调用过 `remember`（`source='agent'` 新增行），跳过——避免重复（对齐 CC「重叠保护」）。用一个回合级布尔标志实现。
2. **长度门控**：最近一条 user 文本 < 8 字，跳过（单句寒暄无价值）。
3. **节流门控**：距上次提取 < N 秒（默认 0 关闭，可配），避免高频轮次每轮都提。
4. **开关门控**：`--auto-memory`（默认开）/ `AGENTCLI_AUTO_MEMORY=0` 可关。

### 2.3 提取流程（伪代码）
```ts
export interface ExtractOptions {
  model: ChatModel;
  store: MemoryStore;
  maxRecentMessages?: number;   // 默认 10
  dialogueCharCap?: number;     // 默认 4000
}

export async function extractMemories(history: ChatMessage[], opts: ExtractOptions): Promise<number> {
  const recent = formatRecent(history, opts.maxRecentMessages ?? 10); // 只取纯文本 user/assistant
  if (recent.trim().length < 8) return 0;
  const existing = opts.store.listAll(200)
    .map((m) => `- ${m.name}: ${m.description}`).join('\n');

  const prompt =
    '从下面对话中提取「用户偏好 / 约束 / 项目事实」。\n' +
    '只提取跨会话仍有用、且无法从项目状态推导的信息。\n' +
    '返回 JSON 数组：[{name, type, description, body}]，type∈{user,feedback,project,reference}。\n' +
    '若无新信息或已被现有记忆覆盖，返回 []。\n\n' +
    `现有记忆：\n${existing}\n\n对话：\n${recent.slice(0, opts.dialogueCharCap ?? 4000)}`;

  const r = await opts.model.complete({
    messages: [{ role: 'user', content: prompt }],
  });
  const items = safeParseJsonArray(r.content);   // 正则抽 [...]，解析失败返回 []
  let n = 0;
  for (const it of items) {
    if (!it?.name || !it?.body) continue;
    if (isDuplicate(it, existingList)) continue;   // 二次去重：name 归一化比对
    opts.store.remember(it.body, 'auto', { name: it.name, description: it.description, type: it.type });
    n++;
  }
  return n;
}
```

### 2.4 挂载代码（`repl.ts`）
```ts
if (!turnError) {
  void persistAutosave();
  if (autoMemoryEnabled && memory && !turnUsedRememberTool) {
    void extractMemories(history, { model, store: memory })
      .then((n) => { if (n > 0) status.setLabel(`🧠 已自动记住 ${n} 条`); })
      .catch(() => { /* 静默 */ });
  }
  ...
}
```
- `turnUsedRememberTool`：本轮开始置 false，工具执行回调里检测 `call.name === 'remember'` 置 true。
- 用 `void`＋`.catch` 保证**永不阻塞、永不冒泡**（与 `persistAutosave` 同一约定）。

### 2.5 权衡
| 维度 | 决策 | 理由 |
|---|---|---|
| 同步 vs 异步 | **fire-and-forget** | 用户零等待，最差晚一轮才可召回（对齐教程 async prefetch 思路的简化版） |
| 存储 | 复用 SQLite（不落 markdown） | 保持项目既有形态；教程用 md 是为可 git/人读，本项目已有可观测层替代 |
| 成本 | 每回合 +1 次模型调用 | 用 4 门控收敛；对话短/已显式记/高频轮次时不触发 |
| forked agent 隔离 | 首版**不做**子进程隔离 | 教学版也直接调用；提取 prompt 无工具、无副作用，风险低 |

---

## 3. 功能②：LLM 语义召回（selectRelevantMemories）

### 3.1 定位与交付物
- 新函数 `selectRelevantMemories()`，建议放 `src/core/context/autoinject.ts`（就近，召回是注入的一部分）或新 `src/core/memory/recall.ts`。
- 改造 `buildAutoContext`：`sources` 增加 `model?`，`opts` 增加 `semantic?: boolean`（默认：给了 model 就启用）。

### 3.2 召回流程（对齐 s09 `select_relevant_memories`）
```ts
export async function selectRelevantMemories(
  query: string,
  candidates: Pick<MemoryRecord,'id'|'name'|'description'>[],
  model: ChatModel,
  max = 5,
): Promise<number[]> {                     // 返回选中的记忆 id 数组
  if (candidates.length <= max) return candidates.map((c) => c.id); // 太少直接全给
  const catalog = candidates
    .map((c, i) => `${i}: ${c.name || '(无名)'} — ${c.description || ''}`).join('\n');
  const r = await model.complete({
    messages: [{ role: 'user', content:
      `根据下面的「最近查询」选出真正相关的记忆（最多 ${max} 个）。不确定就不要选。\n` +
      `只返回 JSON 数组，如 [0,3,7]。\n\n最近查询：\n${query}\n\n记忆清单：\n${catalog}` }],
  });
  const idx = safeParseIntArray(r.content);           // 解析失败 → 抛给调用方降级
  return idx.filter((i) => i >= 0 && i < candidates.length).map((i) => candidates[i]!.id);
}
```

### 3.3 集成进 `buildAutoContext`
```ts
if (sources.memory) {
  const q = query.trim();
  let mem: MemoryRecord[];
  if (sources.model && q && q.split(/\s+/).length > 1) {   // 语义路径（多词查询才值得）
    try {
      const pool = sources.memory.listAll(200);            // 候选清单（轻量）
      const ids = await selectRelevantMemories(q, pool, sources.model, opts.memoryLimit ?? 5);
      mem = sources.memory.getByIds(ids);                  // 读全文
    } catch {
      mem = q ? sources.memory.search(q, ...) : sources.memory.recall(...);  // 降级关键词
    }
  } else {
    mem = q ? sources.memory.search(q, ...) : sources.memory.recall(...);    // 原路径
  }
  ...
}
```
需给 store 补一个 `getByIds(ids: number[]): MemoryRecord[]`。

### 3.4 关键：不破坏 P0 前缀缓存
自动注入已是**以 user 角色注入在缓存前缀之后**（见 `loop.ts` 174–188 行注释），每轮变化本就不进缓存前缀——**语义召回不改变这一性质，安全**。side-query 是独立模型调用，与主对话缓存无关。

### 3.5 门控（省钱）
1. 单词查询跳过语义、走关键词（语义收益低）。
2. 候选 ≤ max 时直接全给，不调模型。
3. `alreadySurfaced` 会话级 Set（可选）：同一记忆本会话已注入过则降权，避免每轮重复注入。
4. 失败**必降级**到现有关键词 `search`，绝不让召回失败影响对话。

### 3.6 权衡
| 维度 | 决策 |
|---|---|
| LLM 选择 vs 向量 embedding | 用 LLM side-query（对齐教程；本项目 RAG 已有向量，记忆召回走 LLM 以理解关联、免维护 embedding 索引） |
| 成本 | 每回合 +1 次轻量调用（仅清单，token 少）；用 3 门控收敛 |
| 放置位置 | `autoinject.ts` 就近（召回 ⊂ 注入） |

---

## 4. 配置与开关（`config` + CLI）

| 配置 | 默认 | 说明 |
|---|---|---|
| `--auto-memory` / `AGENTCLI_AUTO_MEMORY` | on | 功能①自动提取总开关 |
| `--semantic-recall` / `AGENTCLI_SEMANTIC_RECALL` | on（有 model 时） | 功能②语义召回开关，关则回退关键词 |
| `memoryLimit` | 5 | 召回/注入上限（复用现有） |

沿用 `config/index.ts` 的「CLI > env > file > 默认」解析链；仅偏离默认才持久化。

---

## 5. 代码索引（改动清单）

| 文件 | 改动 | 功能 |
|---|---|---|
| `src/core/memory/store.ts` | schema 迁移 + `listAll`/`getByIds` + `remember` 加 meta | 共用 |
| `src/core/memory/extractor.ts` | **新增** `extractMemories` | ① |
| `src/core/context/autoinject.ts` | `selectRelevantMemories` + `buildAutoContext` 分流 | ② |
| `src/cli/repl.ts` | 回合结束挂 `extractMemories`；`turnUsedRememberTool` 标志；传 `model` 给 `buildAutoContext` | ①② |
| `src/cli/main.ts` | 两个开关 CLI/env 接线 | ①② |
| `src/config/index.ts` `store.ts` | 两开关配置项 | ①② |

---

## 6. 测试计划

**功能①（`extractor.test.ts`）**
- 假 model 返回固定 JSON → 断言写入库、条数正确、`source='auto'`。
- model 返回 `[]` / 非法 JSON → 写入 0 条、不抛错。
- 已有同名记忆 → 去重跳过。
- 对话过短 → 直接返回 0，不调用 model。

**功能②（`autoinject.test.ts` 扩展）**
- 假 model 返回 `[0,2]` → 断言 `buildAutoContext` 注入对应记忆。
- 候选 ≤ max → 不调 model、全量返回。
- side-query 抛错 → 降级关键词 `search`，仍有输出。
- 单词查询 → 走关键词路径。

**store 迁移**
- 旧库（无新列）打开后自动 ALTER，旧行 `type` 默认 `'user'`，读写正常。

均用假 `ChatModel`（返回预设 `content`），**不联网、不实际调用大模型**，与现有测试风格一致。

---

## 7. 验收标准
- `tsc --noEmit` 干净；`vitest run` 全绿（新增用例覆盖上述场景）。
- REPL 中说「我以后都用 tab 缩进」→ 下一轮结束出现「🧠 已自动记住 N 条」→ 新提问时被语义召回注入（状态行「⚡ 自动注入上下文：记忆 N 条」）。
- 关闭开关后行为回退到现状（显式 remember + 关键词召回）。
- 任一 side-query 失败均不影响主对话（降级/静默）。

---

## 8. 实施顺序建议
1. **前置**：store schema 迁移 + `listAll`/`getByIds`（无行为变化，先合入）。
2. **功能①**：extractor + repl 挂载 + 测试（价值最高，立即可感知）。
3. **功能②**：selectRelevantMemories + buildAutoContext 分流 + 测试。
4. 文档：完成后回填 `docs/phase4.md` §12 / `CLAUDE.md` / `README.md`。

> 两项合计新增约 2 次/回合的轻量模型调用，已用多重门控收敛；均遵循「失败降级 / 静默、不阻塞、不破坏前缀缓存」三原则。

---

## 9. 真实 API 验证记录（2026-07-11）

用 `agnes-2.0-flash`（`https://apihub.agnes-ai.com/v1`）端到端验证，隔离内存库（`:memory:`）避免污染用户数据：

- **自动提取**：构造含「调试习惯」的对话 → 模型返回结构化 JSON → 写入 1 条 `source='auto'` 记忆 ✅
- **语义召回**：预置 12 条记忆，query「我写代码应该用空格还是 tab 来缩进？」→ 模型从候选清单选中唯一相关条（tab 缩进），注入文本含该事实 ✅
- **关键词召回（对照）**：query「tab 缩进」→ `LIKE` 命中 1 条 ✅
- **降级**：候选 ≤8 时自动跳过语义 path（小池关键词足够）；语义 side-query 抛错时保留关键词结果，主对话不受影响 ✅

结论：两项功能在真实模型下均按设计工作，且严格遵循「失败降级 / 不阻塞 / 不破坏前缀缓存」三原则。
