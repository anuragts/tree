export * from "./agno.js";
export * from "./claude.js";
export * from "./codex.js";
export * from "./normalize.js";

import type { AgentAdapter } from "@tree/core";
import { AgnoAdapter } from "./agno.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

export function createDefaultAdapters(): Map<string, AgentAdapter> {
	return new Map<string, AgentAdapter>([
		["agno", new AgnoAdapter()],
		["claude", new ClaudeAdapter()],
		["codex", new CodexAdapter()],
	]);
}
