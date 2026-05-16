import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { TreeConfig } from "./types.js";

type MutableRecord = Record<string, unknown>;

export const DEFAULT_CONFIG_FILE = "tree.config.toml";

function bunAvailable(): boolean {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return true;
	const result = spawnSync("sh", ["-lc", "command -v bun"], {
		stdio: "ignore",
	});
	return result.status === 0;
}

export function defaultTreeConfig(cwd = process.cwd()): TreeConfig {
	return {
		runtime: bunAvailable() ? "bun" : "node",
		defaultAdapter: "codex",
		cwd,
		sessionDir: resolve(cwd, ".tree", "sessions"),
		adapters: {
			agno: {
				baseUrl: "http://localhost:7867",
				agentId: "coding-agent",
				sidecarAutoStart: true,
				sidecarHost: "localhost",
				sidecarPort: 7867,
			},
			claude: {
				allowedTools: ["Read", "Edit", "Bash"],
				disallowedTools: [],
				permissionMode: "acceptEdits",
				cwd,
			},
			codex: {
				mode: "app-server",
				sandbox: "workspace-write",
				cwd,
			},
		},
	};
}

export function loadTreeConfig(
	options: { cwd?: string; configPath?: string } = {},
): TreeConfig {
	const cwd = resolve(options.cwd ?? process.cwd());
	const configPath = options.configPath
		? resolve(cwd, options.configPath)
		: resolve(cwd, DEFAULT_CONFIG_FILE);
	const base = defaultTreeConfig(cwd);
	if (!existsSync(configPath)) return base;
	const raw = parseTomlSubset(readFileSync(configPath, "utf8"));
	const merged = mergeConfig(base, raw);
	const baseDir = dirname(configPath);
	merged.cwd = resolveMaybe(baseDir, String(merged.cwd || cwd));
	merged.sessionDir = resolveMaybe(
		baseDir,
		String(merged.sessionDir || ".tree/sessions"),
	);
	for (const adapterConfig of Object.values(merged.adapters)) {
		if (
			adapterConfig &&
			typeof adapterConfig === "object" &&
			"cwd" in adapterConfig
		) {
			const current = (adapterConfig as { cwd?: unknown }).cwd;
			if (typeof current === "string") {
				(adapterConfig as { cwd: string }).cwd = resolveMaybe(baseDir, current);
			}
		}
	}
	return merged;
}

function resolveMaybe(baseDir: string, path: string): string {
	return isAbsolute(path) ? path : resolve(baseDir, path);
}

function mergeConfig(base: TreeConfig, raw: MutableRecord): TreeConfig {
	const merged: TreeConfig = {
		...base,
		...raw,
		adapters: {
			...base.adapters,
			...((raw.adapters as MutableRecord | undefined) ?? {}),
		},
	};
	if (raw.adapters && typeof raw.adapters === "object") {
		for (const [name, value] of Object.entries(raw.adapters as MutableRecord)) {
			const current = (base.adapters[name] as MutableRecord | undefined) ?? {};
			merged.adapters[name] =
				value && typeof value === "object" && !Array.isArray(value)
					? { ...current, ...(value as MutableRecord) }
					: value;
		}
	}
	return merged;
}

export function parseTomlSubset(input: string): MutableRecord {
	const root: MutableRecord = {};
	let section: string[] = [];
	for (const rawLine of input.split(/\r?\n/)) {
		const line = stripComment(rawLine).trim();
		if (!line) continue;
		const sectionMatch = line.match(/^\[([^\]]+)\]$/);
		if (sectionMatch) {
			section = sectionMatch[1]
				.split(".")
				.map((part) => part.trim())
				.filter(Boolean);
			ensurePath(root, section);
			continue;
		}
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		const value = parseValue(line.slice(eq + 1).trim());
		const target = ensurePath(root, section);
		target[key] = value;
	}
	return root;
}

function ensurePath(root: MutableRecord, path: string[]): MutableRecord {
	let current = root;
	for (const part of path) {
		if (
			!current[part] ||
			typeof current[part] !== "object" ||
			Array.isArray(current[part])
		) {
			current[part] = {};
		}
		current = current[part] as MutableRecord;
	}
	return current;
}

function stripComment(line: string): string {
	let quoted = false;
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if ((ch === '"' || ch === "'") && line[i - 1] !== "\\") {
			if (!quoted) {
				quoted = true;
				quote = ch;
			} else if (quote === ch) {
				quoted = false;
			}
		}
		if (!quoted && ch === "#") return line.slice(0, i);
	}
	return line;
}

function parseValue(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
	if (raw.startsWith("[") && raw.endsWith("]")) {
		const inner = raw.slice(1, -1).trim();
		if (!inner) return [];
		return splitArray(inner).map((item) => parseValue(item.trim()));
	}
	if (
		(raw.startsWith('"') && raw.endsWith('"')) ||
		(raw.startsWith("'") && raw.endsWith("'"))
	) {
		return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
	}
	return raw;
}

function splitArray(inner: string): string[] {
	const out: string[] = [];
	let current = "";
	let quoted = false;
	let quote = "";
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if ((ch === '"' || ch === "'") && inner[i - 1] !== "\\") {
			if (!quoted) {
				quoted = true;
				quote = ch;
			} else if (quote === ch) {
				quoted = false;
			}
		}
		if (!quoted && ch === ",") {
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) out.push(current);
	return out;
}
