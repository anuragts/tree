import type { SelectItem } from "@earendil-works/pi-tui";

export const MODEL_CATALOG: Record<string, SelectItem[]> = {
	codex: [
		{ value: "gpt-5.5", label: "GPT-5.5" },
		{ value: "gpt-5.4", label: "GPT-5.4" },
		{ value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
		{ value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
		{ value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
		{ value: "gpt-5.2", label: "GPT-5.2" },
	],
	claude: [
		{ value: "claude-opus-4-7", label: "Opus 4.7" },
		{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
		{ value: "claude-haiku-4-5", label: "Haiku 4.5" },
	],
	agno: [],
};

export const FAST_MODE_MODELS: Record<string, string[]> = {
	codex: ["gpt-5.5", "gpt-5.4"],
	claude: ["claude-opus-4-7", "claude-opus-4-6"],
};
