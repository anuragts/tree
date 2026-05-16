import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const WORKSPACE_ENV_FILE = ".env";

export interface WorkspaceEnvLoadResult {
	path: string;
	values: Record<string, string>;
	loaded: string[];
	skipped: string[];
}

export interface WorkspaceEnvWriteResult {
	envPath: string;
	gitignorePath: string;
	updatedGitignore: boolean;
}

export function loadWorkspaceEnv(cwd: string): WorkspaceEnvLoadResult {
	const envPath = resolve(cwd, WORKSPACE_ENV_FILE);
	if (!existsSync(envPath)) {
		return { path: envPath, values: {}, loaded: [], skipped: [] };
	}
	const values = parseEnvFile(readFileSyncUtf8(envPath));
	return { path: envPath, values, loaded: [], skipped: [] };
}

export function applyWorkspaceEnv(cwd: string): WorkspaceEnvLoadResult {
	const result = loadWorkspaceEnv(cwd);
	for (const [name, value] of Object.entries(result.values)) {
		if (process.env[name] === undefined) {
			process.env[name] = value;
			result.loaded.push(name);
		} else {
			result.skipped.push(name);
		}
	}
	return result;
}

export function parseEnvFile(input: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of input.split(/\r?\n/)) {
		const parsed = parseEnvAssignment(rawLine);
		if (parsed) values[parsed.name] = parsed.value;
	}
	return values;
}

export async function writeWorkspaceEnvValue(
	cwd: string,
	name: string,
	value: string,
): Promise<WorkspaceEnvWriteResult> {
	if (!isValidEnvName(name)) throw new Error(`Invalid env var name: ${name}`);
	const envPath = resolve(cwd, WORKSPACE_ENV_FILE);
	await mkdir(dirname(envPath), { recursive: true });
	const existing = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
	const updatedEnv = upsertEnvValue(existing, name, value);
	await writeFile(envPath, updatedEnv, { encoding: "utf8", mode: 0o600 });
	await chmod(envPath, 0o600).catch(() => undefined);
	const gitignore = await ensureWorkspaceEnvGitignore(cwd);
	return {
		envPath,
		gitignorePath: gitignore.path,
		updatedGitignore: gitignore.updated,
	};
}

export async function ensureWorkspaceEnvGitignore(
	cwd: string,
): Promise<{ path: string; updated: boolean }> {
	const path = resolve(cwd, ".gitignore");
	const existing = existsSync(path) ? await readFile(path, "utf8") : "";
	const lines = existing.split(/\r?\n/).map((line) => line.trim());
	const required = [".env", ".env.*", "!.env.example"];
	const missing = required.filter((entry) => !lines.includes(entry));
	if (missing.length === 0) return { path, updated: false };
	const prefix =
		existing.length > 0 ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
	const section = `${prefix}# Environment and secrets\n${missing.join("\n")}\n`;
	await writeFile(path, existing + section, "utf8");
	return { path, updated: true };
}

function readFileSyncUtf8(path: string): string {
	return readFileSync(path, "utf8");
}

function upsertEnvValue(input: string, name: string, value: string): string {
	const lines = input.length > 0 ? input.split(/\r?\n/) : [];
	const nextLine = `${name}=${formatEnvValue(value)}`;
	let replaced = false;
	const next = lines.map((line) => {
		const parsed = parseEnvAssignment(line);
		if (parsed?.name !== name) return line;
		replaced = true;
		return nextLine;
	});
	if (!replaced) {
		if (next.length > 0 && next[next.length - 1] === "") next.pop();
		next.push(nextLine);
	}
	return `${next.join("\n")}\n`;
}

function parseEnvAssignment(
	line: string,
): { name: string; value: string } | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;
	const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
	if (!match) return undefined;
	const name = match[1];
	const rawValue = trimmed.slice(match[0].length).trim();
	return { name, value: parseEnvValue(rawValue) };
}

function parseEnvValue(raw: string): string {
	if (!raw) return "";
	const quote = raw[0];
	if (quote === '"' || quote === "'") {
		let value = "";
		for (let i = 1; i < raw.length; i++) {
			const ch = raw[i];
			if (ch === quote)
				return quote === '"' ? unescapeDoubleQuoted(value) : value;
			value += ch;
		}
		return quote === '"' ? unescapeDoubleQuoted(value) : value;
	}
	return stripInlineComment(raw).trim();
}

function stripInlineComment(raw: string): string {
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1] ?? ""))) {
			return raw.slice(0, i);
		}
	}
	return raw;
}

function unescapeDoubleQuoted(value: string): string {
	return value
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

function formatEnvValue(value: string): string {
	if (/^[^\s#"'\\]+$/.test(value)) return value;
	return `"${value
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")
		.replace(/"/g, '\\"')}"`;
}

function isValidEnvName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
