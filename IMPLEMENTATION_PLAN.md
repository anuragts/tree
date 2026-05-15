# Tree Coding Agent Implementation Plan

This repository implements the plan in `PLAN.md` as a TypeScript-only, Bun-first coding-agent scaffold.

## Phases

1. Scaffold a Bun/npm workspace with `apps/tree-cli`, `packages/core`, `packages/tui`, and `packages/adapters`.
2. Build the core runtime contracts, config loader, runtime host abstraction, event normalization, and JSONL session store.
3. Add adapters for Agno AgentOS, Claude Agent SDK/CLI fallback, and OpenAI Codex app-server/exec fallback.
4. Add a PI-inspired terminal UI using `@earendil-works/pi-tui` with slash commands and session navigation.
5. Add CLI commands for interactive use, print mode, config inspection, session listing, export, and adapter discovery.
6. Test the parser, session tree, SSE handling, runtime host, and adapter event normalization.

## Runtime Policy

Bun is the preferred runtime for development and local execution. The built output is ESM and remains runnable with Node 20+ when Bun is unavailable.

## Adapter Policy

Adapters emit a shared `TreeEvent` stream so the UI and session store do not depend on any single framework.

- Agno talks to AgentOS over HTTP and SSE.
- Claude first tries the local SDK seam, then falls back to the `claude` CLI.
- Codex uses `codex app-server` as the primary protocol seam and falls back to `codex exec` for noninteractive runs.
