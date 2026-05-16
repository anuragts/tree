import type { SelectItem } from "@earendil-works/pi-tui";

export const MODEL_CATALOG: Record<string, SelectItem[]> = {
	codex: [
		{ value: "gpt-5-codex", label: "gpt-5-codex" },
		{ value: "gpt-5", label: "gpt-5" },
		{ value: "o4-mini", label: "o4-mini" },
	],
	claude: [
		{ value: "claude-opus-4-7", label: "Opus 4.7" },
		{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
		{ value: "claude-haiku-4-5", label: "Haiku 4.5" },
	],
	agno: [],
};

export const FAST_MODE_MODELS: Record<string, string[]> = {
	codex: ["gpt-5-codex", "gpt-5"],
	claude: ["claude-opus-4-7", "claude-opus-4-6"],
};
