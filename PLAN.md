# Tree Coding Agent Plan

## Summary

Build `tree` as a TypeScript-only local terminal coding agent with a PI-inspired TUI and an agnostic runtime layer.

Target artifact for implementation: `/Users/anurag/kafka/tree/IMPLEMENTATION_PLAN.md`.

Core decisions:
- Use a PI-like TUI, preferably via `@earendil-works/pi-tui`, with chat stream, editor, footer, tool cards, overlays, session tree, and slash commands.
- Keep `tree` framework-agnostic through an `AgentAdapter` contract.
- Ship local TUI first.
- Support Agno through AgentOS HTTP/SSE, not in-repo Python code.
- Add Claude Agent SDK and OpenAI Codex as sibling adapters, not special cases.

## Key Interfaces

Define `tree.config.toml` with:
- `defaultAdapter`
- `cwd`
- `sessionDir`
- `adapters.agno.baseUrl`, `agentId`, `authToken`, optional `sidecarCommand`
- `adapters.claude.model`, `allowedTools`, `disallowedTools`, `permissionMode`, `cwd`
- `adapters.codex.mode = "app-server" | "exec" | "mcp"`, `model`, `sandbox`, `cwd`

Define core runtime types:
- `AgentAdapter`: `listAgents`, `startSession`, `sendMessage`, `continueRun`, `cancelRun`, `dispose`
- `TreeEvent`: `run_started`, `assistant_delta`, `tool_started`, `tool_completed`, `approval_requested`, `run_paused`, `run_completed`, `run_error`, `usage`, `log`
- Append-only JSONL session entries with `id`, `parentId`, `timestamp`, and entry types for messages, tools, approvals, adapter state, model changes, compaction, labels, and session info.

## Implementation Phases

1. **Repo Scaffold**
   - Create an npm workspace with `apps/tree-cli`, `packages/core`, `packages/tui`, and `packages/adapters`.
   - Add TypeScript, Vitest, Biome, config loading, and a root CLI binary named `tree`.

2. **TUI MVP**
   - Build the PI-style terminal shell: scrollable messages, multiline editor, footer, status line, slash-command overlay, model/adapter selector, and cancellable loader.
   - Implement `/new`, `/resume`, `/adapter`, `/agents`, `/permissions`, `/cancel`, `/tree`, `/fork`, `/export`, and `/help`.

3. **Core Runtime**
   - Add event bus, session persistence, branch navigation, prompt queueing, cancellation, and adapter-neutral tool rendering.
   - Normalize every adapter stream into `TreeEvent` so the TUI never depends directly on Agno, Claude, or Codex internals.

4. **Adapters**
   - Agno: use `GET /agents`, `POST /agents/{agent_id}/runs`, SSE stream parsing, `POST /agents/{agent_id}/runs/{run_id}/cancel`, `POST /agents/{agent_id}/runs/{run_id}/continue`, and `/approvals` resolve/list endpoints.
   - Claude: use the TypeScript Claude Agent SDK with continuous sessions, mapped `allowedTools`, `disallowedTools`, and `permissionMode`.
   - Codex: use `codex app-server` JSON-RPC over stdio as the primary interactive adapter; keep `codex exec` for simple noninteractive runs and `codex mcp-server` for future orchestration.

5. **Coding Tool Policy**
   - Agno default profile expects `Workspace(".", allowed=["read","list","search"], confirm=["write","edit","delete","shell"])`.
   - Claude defaults to conservative permissions and lets users elevate through `/permissions`.
   - Codex inherits its sandbox and approval settings from config/app-server.
   - Add native TUI-only helpers for file mentions, path autocomplete, git status, and local shell snippets.

6. **Polish And Packaging**
   - Add themes, keybindings, images/file attachments where adapter support exists, HTML/Markdown export, startup diagnostics, and docs.
   - Write the final phased implementation plan into `IMPLEMENTATION_PLAN.md`.

## Test Plan

- Unit test config parsing, session JSONL migration, branch tree building, SSE parsing, JSON-RPC parsing, and event normalization.
- Contract-test each adapter against fake Agno, Claude, and Codex event streams.
- TUI snapshot/smoke tests with virtual terminals at 80x24 and narrow widths.
- Integration test Agno against a mocked AgentOS server with run, pause, approval, continue, and cancel flows.
- Manual acceptance: launch `tree`, select Agno, stream a coding prompt, show tool cards, resolve an approval, cancel a run, resume the session, and navigate `/tree`.

## Assumptions

- `tree` stays TypeScript-only; Agno runs as an external AgentOS service or user-provided sidecar.
- PI is used for architecture/UI inspiration, not copied wholesale.
- First milestone is local terminal UX; API/server surfaces come after the TUI is useful.
- References checked: [PI coding agent README](/Users/anurag/kafka/pi/packages/coding-agent/README.md), [PI TUI README](/Users/anurag/kafka/pi/packages/tui/README.md), [Agno README](/Users/anurag/labs/agno/README.md), [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/python), [Claude permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [Codex CLI](https://developers.openai.com/codex/cli), [Codex app-server](https://developers.openai.com/codex/app-server), and [Codex with Agents SDK](https://developers.openai.com/codex/guides/agents-sdk).
