# AGENTS.md

This file provides guidance to Lingma (lingma.aliyun.com) when working with code in this repository.

## Build & Development Commands

```bash
pnpm dev            # Run interactive REPL (tsx, no build step)
pnpm build          # Bundle with tsup → dist/cli/main.js
pnpm start          # Run built output: node dist/cli/main.js
pnpm test           # Run all tests: vitest run
pnpm typecheck      # Type check only: tsc --noEmit
pnpm lint           # ESLint
```

**Running a single test:**
```bash
npx vitest run tests/unit/cache.test.ts
npx vitest run -t "test name pattern"   # filter by test name
```

**One-shot prompt (non-interactive):**
```bash
pnpm dev -p "explain ReAct in one sentence"
pnpm dev --plan -p "plan a refactor of X"  # plan mode (read-only tools only)
```

## Architecture Overview

This is a **Claude Code-inspired CLI agent** written in TypeScript/Node.js (ESM, `"type": "module"`). The core loop follows a **ReAct** (Reasoning → Acting → Observing) pattern where an LLM decides which tools to call, observes results, and iterates until producing a final answer.

### Key Architectural Boundaries

```
src/cli/          →  Entry point, REPL orchestration, slash commands, rendering
src/core/agent/   →  Agent loop engine (ReAct + Plan-and-Execute)
src/core/chatmodel/ →  Provider-agnostic ChatModel interface + adapters
src/core/tools/   →  Tool registry, executor, built-in tools
src/core/mcp/     →  MCP client/server (thin façades over @modelcontextprotocol/sdk)
src/core/memory/  →  Context compression (5-layer progressive) + SQLite long-term memory
src/core/rag/     →  Vector retrieval (hand-rolled TF-IDF + SQLite, pluggable API embedder)
src/core/skill/   →  Three-layer skill loading (builtin/user/project) + progressive disclosure
src/core/multiagent/ → Multi-Agent orchestrator (Planner → Workers with git worktree isolation → Reviewer)
src/core/security/  →  Permission gate, path sandbox, command blacklist, HITL approval, audit log
src/core/events/    →  Minimal event bus (decouples agent loop from audit/observability)
src/core/prompts/   →  Composable system prompt blocks (identity/behavior/tool-policy/output-format)
src/core/context/   →  Auto-inject: memory + RAG results per turn
src/core/tasks/     →  Persistent dependency task graph (.tasks/{id}.json)
src/config/         →  Config loading/merging (CLI > env > file > defaults)
src/tui/            →  Ink (React) declarative TUI: App, components, zustand store, bridge
tests/unit/         →  vitest regression tests
```

### Critical Design Patterns

**ChatModel Interface** (`src/core/chatmodel/types.ts`): All LLM adapters implement `ChatModel.complete(opts)` returning `{ content, toolCalls, usage? }`. Adding a new provider = adding a new adapter; zero changes to the agent loop. Currently: OpenAI-compatible, Anthropic, Ollama, with optional fallback model.

**ToolDef as Universal Contract**: Both built-in tools and MCP tools share the same `ToolDef` type with `inputSchema` (JSON Schema), `execute()`, and concurrency flags (`isReadOnly`/`isDestructive`). The executor runs read-only tools in parallel (bounded concurrency pool) and write/destructive tools serially.

**ToolRegistry** (`src/core/tools/registry.ts`): Single `Map<string, ToolDef>` — the agent loop only knows about this registry, not whether a tool is local or from an MCP server.

**Event Bus** (`src/core/events/bus.ts`): Decoupled pub/sub for `tool:call`, `tool:result`, `tool:batch`, `compact`, `token`, `error`, `agent:spawn/done/error`. AuditLogger and CostTracker are subscribers, not hardcoded into the loop.

**5-Layer Progressive Compression** (`src/core/memory/compressor.ts`):
- L0.5: Large tool results (>30KB) persisted to disk with preview markers
- L1: Selective truncation (keep recent 3 tool results intact)
- L2: Deduplicate adjacent identical tool results
- L3: Fold middle tool results to placeholders (preserve tool_call pairs)
- L4: LLM summary of middle turns (only at turn boundary, hash-cached for prompt cache friendliness)

Budget is derived from context window: `window - max(maxOut, 16384) - 20000` (floor 8000). A `reactiveCompact` fallback handles 413/prompt_too_long errors.

**Multi-Agent** (`src/core/multiagent/orchestrator.ts`): Three phases — Planner (produces structured JSON plan with dependency graph, validated by zod) → Workers (topological scheduling with git worktree isolation per worker) → Reviewer (aggregates results). Each worker is a `runAgent` call with a role-specific system prompt.

**Subagent** (`src/core/multiagent/subagent.ts`): The `task` tool lets the main agent spawn child agents within the ReAct loop. Children have fresh `messages[]` (context isolation) but share the main `cwd` (filesystem side effects preserved). The `task` tool is stripped from child toolsets to prevent recursion.

**TUI Architecture** (`src/tui/`): Ink (React declarative) with a zustand vanilla store as the single source of truth. `bridge.ts` mediates between the agent loop and the Ink render tree. The `ReplView` abstraction in `src/cli/repl-view.ts` provides a unified API for both TTY (Ink) and non-TTY (readline + plain text) backends.

### Configuration Priority (high → low)

CLI flags (`--api-key`, `--model`, `--base-url`) → Environment variables (`AGENTCLI_API_KEY`, `AGENTCLI_BASE_URL`, `AGENTCLI_MODEL`) → Config file (`~/.config/agent-cli/config.json`) → Defaults.

Empty strings are treated as "not set" (`firstNonEmpty` utility). The config file is the "persistent defaults" layer — it takes effect on startup but can be overridden per-run.

### Prompt Cache Strategy

System prompts are constructed once per session with frozen `now` timestamp to keep the prefix stable across turns. Tool definitions are sorted by name for deterministic ordering. `cache_control` breakpoints are placed at system+tools boundary and the last cached history message. Auto-injected context (memory/RAG) is inserted as a `user` message near the last user input, never prepended to system (preserves Anthropic prefix cache).

### Key File Paths for Common Tasks

| Task | Start Here |
|------|-----------|
| Add a new built-in tool | `src/core/tools/builtin.ts` (define ToolDef), register in `createToolRegistry()` |
| Add a new LLM adapter | Implement `ChatModel` in `src/core/chatmodel/`, wire in `createChatModel()` |
| Add a new slash command | `src/cli/commands.ts` (metadata) + `handleSlash()` in `src/cli/repl.ts` |
| Modify system prompts | `src/core/prompts/index.ts` (composable blocks) |
| Add MCP server config | `src/core/mcp/client.ts` (McpServerSpec + connectMcpServers) |
| Add a new event type | `src/core/events/bus.ts` (AgentEventType union) |
| Modify compression | `src/core/memory/compressor.ts` (CompressOptions + layer functions) |
| Add TUI component | `src/tui/components/` + subscribe to `AppStore` via `useAppStore()` |

### Testing Conventions

- Test framework: **vitest** with `environment: 'node'`
- Tests live in `tests/unit/*.test.ts`
- `node:sqlite` is marked as external in vitest config (loaded at runtime via `createRequire`)
- No test globals — explicit imports required

### TypeScript Configuration Notes

- Target: ES2022, Module: ESNext (Bundler resolution)
- `strict: true` with `noUncheckedIndexedAccess` and `noImplicitOverride`
- JSX: `react-jsx` (for Ink components in `src/tui/`)
- Build: tsup with `format: ['esm']`, `target: 'node22'`, `platform: 'node'`

### Runtime Data Locations

All user data lives under `~/.config/agent-cli/`:
- `config.json` — persisted configuration
- `memory.db` — SQLite long-term memory store
- `rag.db` — SQLite RAG vector index
- `audit.jsonl` — audit log (event bus subscriber)
- `sessions/` — saved conversation sessions
- `tool-results/` — persisted large tool outputs (L0.5 compression)
- `transcripts/` — conversation transcripts
