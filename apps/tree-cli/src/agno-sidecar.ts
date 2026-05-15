import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RuntimeHost, SpawnHandle, TreeConfig } from "@tree/core";

export interface ManagedSidecar {
	notice?: string;
	stop(): Promise<void>;
}

const DEFAULT_AGNO_REPO =
	process.env.TREE_AGNO_REPO ?? "/Users/anurag/labs/agno";
const DEFAULT_AGNO_PORT = 7867;

export async function maybeStartAgnoSidecar(
	config: TreeConfig,
	runtime: RuntimeHost,
): Promise<ManagedSidecar | undefined> {
	if (config.defaultAdapter !== "agno") return undefined;
	const agno = config.adapters.agno;
	if (agno?.sidecarAutoStart === false) return undefined;

	const baseUrl = normalizeBaseUrl(
		agno?.baseUrl ?? `http://localhost:${DEFAULT_AGNO_PORT}`,
	);
	const existing = await agentOsReady(baseUrl);
	if (existing) {
		return {
			notice: `using existing Agno AgentOS at ${baseUrl}`,
			async stop() {},
		};
	}

	const env = sidecarEnv(config);
	const logPath = resolve(config.cwd, ".tree", "agno-sidecar.log");
	await mkdir(dirname(logPath), { recursive: true });

	const handle = agno?.sidecarCommand
		? runtime.spawn("sh", ["-lc", agno.sidecarCommand], {
				cwd: agno.sidecarCwd ?? config.cwd,
				env,
			})
		: runtime.spawn(
				resolvePython(),
				[resolve(config.cwd, "agents", "agno_coding_agent.py")],
				{
					cwd: config.cwd,
					env,
				},
			);

	pipeSidecarLog(logPath, "stdout", handle.stdout);
	pipeSidecarLog(logPath, "stderr", handle.stderr);

	const ready = await waitForAgentOs(baseUrl, 12_000, handle);
	const notice = ready
		? `started Agno AgentOS at ${baseUrl}`
		: `Agno AgentOS is starting at ${baseUrl}; logs: ${logPath}`;

	return {
		notice,
		async stop() {
			handle.kill("SIGTERM");
			const timeout = new Promise<"timeout">((resolveTimeout) =>
				setTimeout(() => resolveTimeout("timeout"), 1500),
			);
			const exited = await Promise.race([handle.exitCode, timeout]);
			if (exited === "timeout") handle.kill("SIGKILL");
		},
	};
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
}

async function waitForAgentOs(
	baseUrl: string,
	timeoutMs: number,
	handle: SpawnHandle,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await agentOsReady(baseUrl)) return true;
		const exited = await Promise.race([
			handle.exitCode.then((code) => code),
			new Promise<undefined>((resolveTimeout) =>
				setTimeout(() => resolveTimeout(undefined), 250),
			),
		]);
		if (exited !== undefined) return false;
	}
	return false;
}

async function agentOsReady(baseUrl: string): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 750);
	try {
		const response = await fetch(`${baseUrl}/agents`, {
			signal: controller.signal,
		});
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

function sidecarEnv(config: TreeConfig): Record<string, string | undefined> {
	const agno = config.adapters.agno;
	const port = String(agno?.sidecarPort ?? DEFAULT_AGNO_PORT);
	const host = agno?.sidecarHost ?? "localhost";
	const agnoPath = resolve(DEFAULT_AGNO_REPO, "libs", "agno");
	const pythonPath = existsSync(agnoPath) ? agnoPath : undefined;
	return {
		PYTHONPATH: pythonPath
			? appendPath(process.env.PYTHONPATH, pythonPath)
			: process.env.PYTHONPATH,
		TREE_WORKSPACE: config.cwd,
		TREE_AGNO_DB: resolve(config.cwd, ".tree", "agno-agentos.db"),
		TREE_AGNO_HOST: host,
		TREE_AGNO_PORT: port,
	};
}

function resolvePython(): string {
	const fromEnv = process.env.TREE_AGNO_PYTHON;
	if (fromEnv) return fromEnv;
	const agnoVenvPython = resolve(DEFAULT_AGNO_REPO, ".venv", "bin", "python");
	if (existsSync(agnoVenvPython)) return agnoVenvPython;
	return "python3";
}

function appendPath(current: string | undefined, next: string): string {
	return current ? `${next}:${current}` : next;
}

function pipeSidecarLog(
	logPath: string,
	label: string,
	stream: AsyncIterable<string>,
): void {
	void (async () => {
		for await (const line of stream) {
			await appendFile(
				logPath,
				`[${new Date().toISOString()}] ${label}: ${line}`,
				"utf8",
			);
		}
	})();
}
