# Ink 社区 UI 方案调研与界面美化路线

> 调研时间：2026-07-12
> 适用项目：easyCLI（TUI 层基于 Ink 4.4.1 + React 18.3.1 + zustand）
> 目的：在保持现有自研组件的前提下，提升终端界面美观度与一致性。

---

## 1. 背景与约束

easyCLI 已自建一套完整的 Ink 组件（Transcript / StatusLine / StatusBar / InputBox / Approval），
真实痛点不是「组件缺失」，而是**视觉一致性**与**splash/loading 美化**。

**硬约束（已用 `npm view` 实测）**：项目锁定 `ink@4.4.1` + `react@18.3.1`。
各库 peerDependencies 实测结果决定可用集合：

| 库 | 要求 | 本项目可用性 |
|---|---|---|
| `ink-big-text` | `ink >=4` | ✅ 立即可用 |
| `ink-spinner` | `ink >=4` | ✅ 立即可用 |
| `@kud/ink-ui` | `ink >=4` + `react>=18` | ✅ 立即可用 |
| `@inkjs/ui@2.0.0` | `ink >=5` | ⚠️ 需升 Ink |
| `ink-gradient` | `ink >=6` + `react>=19.2` | ❌ 需升 Ink+React |

ink 最新已到 7.1.0（要求 react>=19.2）；但 **ink 5.2.1 仅要求 react>=18**——
即升级 `ink 4→5` 不需要升 React，只需回归现有 5 个自研组件即可解锁 `@inkjs/ui` 主题系统。

---

## 2. 社区主流方案对比

| 库 | GitHub 星数 | 组件丰富度 | 样式定制 | 动画 | Ink 兼容(本项目) | 维护状态 |
|---|---|---|---|---|---|---|
| **`@inkjs/ui`**（vadimdemedes/ink-ui，Ink 作者维护） | ~1.6k | ⭐⭐⭐⭐⭐ 最全：TextInput/Email/Password/Confirm/Select/MultiSelect/Spinner/ProgressBar/Badge/Alert/StatusMessage/List | ⭐⭐⭐⭐ `ThemeProvider`+`extendTheme`+`useComponentTheme` 主题系统 | ⭐⭐ Spinner/Progress | ⚠️ 需 ink≥5 | 中（作者即 Ink 作者，2024-05 后更新放缓） |
| **`@kud/ink-ui`** | 较少 | ⭐⭐⭐⭐ 10 组件：Banner/Header/Badge/Spinner/Table/Tabs/FooterHints/LoadingScreen/KeyValue/SelectableRow | ⭐⭐⭐ 设计 token（colors/spacing） | ⭐⭐ Spinner/Loading | ✅ ink≥4 + react≥18 | 较新 |
| **`ink-big-text`** | ~140 | ⭐ 仅大字 banner（基于 **cfonts**） | ⭐ 字体预置 | ❌ 静态 | ✅ ink≥4 | 停滞（2023）但 44k 周下载 |
| **`ink-gradient`** | ~159 | ⭐ 渐变文字 | ⭐ 渐变方向/色 | ❌ 静态 | ❌ 需 ink≥6 + react≥19.2 | 停滞（2023） |
| **`ink-spinner`** | ~166 | ⭐ 旋转加载（基于 cli-spinners） | ❌ | ⭐⭐⭐ 丰富 spinner 集 | ✅ ink≥4 | 停滞但 613k 周下载 |
| `ink-select-input` / `ink-text-input` | ~300+ | ⭐⭐ 基础输入 | ❌ | ❌ | ink 旧版需验证 | 老 |

**结论**：社区里真正称得上「设计系统」的只有 **`@inkjs/ui`**（Ink 作者维护，质量与一致性最高），
其余都是单点 widget。

---

## 3. 替代方案（社区组件有限 / 不想动 Ink 版本时）

界面真实缺口是**视觉打磨**与**排版规划**，可用：

1. **排版规划**：先参考 [awesome-terminal-aesthetics](https://github.com/kud/awesome-terminal-aesthetics)，
   在编辑器里用 ASCII 画布排好布局再落地。
2. **Splash 大字标题**：
   - **`cfonts`**（Node 库，强推）：12 种字体 + 原生渐变 + 背景色 + 对齐，比 `ink-big-text` 现代，
     可程序化 `cfonts.render('easyCLI', { font:'chrome', gradient:['cyan','blue'] })`。
     `ink-big-text` 本身就是它的 React 薄封装。
   - `figlet.js`：经典 ASCII art，老牌稳定。
3. **设计语言借鉴**（非 JS，范式可抄）：
   - **Charm 生态**（Go）：Lip Gloss（声明式边框/对齐/间距）、Glamour（markdown）、Bubbles（组件范式）。
   - **clack**（TS）：极美 prompt 设计，配色与圆角可直接借鉴到 StatusBar/Approval。
   - **blessed / neo-blessed**：命令式控件库，基本停止维护，不推荐新项目。

---

## 4. 推荐落地路线（分阶段，风险可控）

### Phase 1 — 低风险，现在就能做（不升级 Ink）
- **Splash 标题**：用 `cfonts`（即 `ink-big-text` 的底层引擎）渲染大字渐变标题，
  替换现有手绘框里的普通文字标题。
  > 说明：因 splash 当前以「文本行」形式进入 transcript（`initialTranscript`），
  > 用 `cfonts` 直接产出字符串是最干净的集成；`ink-big-text` 是 React 组件，需挂到 Ink 树，
  > 在文本行模型下反而多一层转换。
- **Loading**：用 `ink-spinner` 替换 StatusLine 的 footer 动画占位（它是 React 组件，StatusLine 已是组件，直接渲染）。
- 自研组件内：加强 `chalk` 配色层级 + Unicode box-drawing（`┌─┐│└┘`）边框统一。

### Phase 2 — 中风险，评估 ink 4→5 升级后引入
- 把 `ink` 升到 `5.2.1`（保持 react 18），引入 `@inkjs/ui` 的 `ThemeProvider`/`extendTheme`
  做全站统一主题（Badge/Alert/StatusMessage 增强现有 StatusLine、Approval 确认弹窗），
  彻底解决「各组件配色不统一」。
- 回归现有 5 个组件 + 跑全套 vitest（现有 433 例保障）。

### Phase 3 — 可选进阶
- 引入 `cfonts` 做电影级 splash；参考 Charm/clack 设计语言重做 StatusBar/InputBox 视觉层次。

---

## 5. 决策建议

最优性价比：**先做 Phase 1 兼容子集**（`cfonts` + `ink-spinner`，零升级风险，半天可落地），
再单独评估 ink 4→5 升级以解锁 `@inkjs/ui` 主题系统。

**Phase 1 集成要点（已落地）**
- 依赖：`cfonts`（splash 大字）、`ink-spinner`（StatusLine 加载）。
- splash 仍走 `renderSplash()` 文本行模型，仅标题段替换为 cfonts 渐变大字，行为等价保留（首部常驻、随 transcript 滚动）。
- StatusLine 在动画区渲染 `<Spinner type="dots" />`，替换原静态占位。
