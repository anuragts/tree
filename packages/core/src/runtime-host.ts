import { spawn as nodeSpawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type {
	ExecResult,
	RuntimeHost,
	RuntimePreference,
	SpawnHandle,
	SpawnOptions,
} from "./types.js";

function isRunningOnBun(): boolean {
	return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

async function* streamToLines(
	stream: NodeJS.ReadableStream | null,
): AsyncIterable<string> {
	if (!stream) return;
	const rl = createInterface({ input: stream });
	for await (const line of rl) {
		yield `${line}\n`;
	}
}

function resolveKind(preference: RuntimePreference): "bun" | "node" {
	if (preference === "node") return "node";
	if (preference === "bun" && isRunningOnBun()) return "bun";
	if (preference === "auto" || preference === "bun") {
		return isRunningOnBun() ? "bun" : "node";
	}
	return "node";
}

export function createRuntimeHost(
	preference: RuntimePreference = "auto",
): RuntimeHost {
	return new DefaultRuntimeHost(resolveKind(preference));
}

class DefaultRuntimeHost implements RuntimeHost {
	constructor(readonly kind: "bun" | "node") {}

	cwd(): string {
		return process.cwd();
	}

	env(name: string): string | undefined {
		return process.env[name];
	}

	async which(command: string): Promise<string | null> {
		const result = await this.exec("sh", [
			"-lc",
			`command -v ${JSON.stringify(command)}`,
		]);
		if (result.exitCode !== 0) return null;
		const resolved = result.stdout.trim();
		return resolved.length > 0 ? resolved : null;
	}

	spawn(
		command: string,
		args: string[],
		options: SpawnOptions = {},
	): SpawnHandle {
		const child = nodeSpawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (options.signal) {
			if (options.signal.aborted) child.kill();
			else
				options.signal.addEventListener("abort", () => child.kill(), {
					once: true,
				});
		}
		const exitCode = once(child, "exit").then(
			([code]) => code as number | null,
		);
		return {
			pid: child.pid,
			stdout: streamToLines(child.stdout),
			stderr: streamToLines(child.stderr),
			writeStdin(data: string): void {
				child.stdin?.write(data);
			},
			closeStdin(): void {
				child.stdin?.end();
			},
			kill(signal?: NodeJS.Signals | number): void {
				child.kill(signal);
			},
			exitCode,
		};
	}

	async exec(
		command: string,
		args: string[],
		options: SpawnOptions & { timeoutMs?: number } = {},
	): Promise<ExecResult> {
		const controller = new AbortController();
		const timeout =
			options.timeoutMs && options.timeoutMs > 0
				? setTimeout(() => controller.abort(), options.timeoutMs)
				: undefined;
		const signal = options.signal ?? controller.signal;
		const handle = this.spawn(command, args, { ...options, signal });
		let stdout = "";
		let stderr = "";
		await Promise.all([
			(async () => {
				for await (const chunk of handle.stdout) stdout += chunk;
			})(),
			(async () => {
				for await (const chunk of handle.stderr) stderr += chunk;
			})(),
		]);
		if (timeout) clearTimeout(timeout);
		return { exitCode: await handle.exitCode, stdout, stderr };
	}
}
