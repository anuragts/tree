#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDefaultAdapters } from "@tree/adapters";
import {
	type AgentAdapter,
	applyWorkspaceEnv,
	createRuntimeHost,
	loadTreeConfig,
	type RuntimeHost,
	SessionStore,
	type TreeConfig,
	type TreeEvent,
} from "@tree/core";
import { TreeTuiApp } from "@tree/tui";
import {
	type ManagedSidecar,
	maybeStartAgnoSidecar,
	startAgnoSidecar,
} from "./agno-sidecar.js";

interface CliArgs {
	configPath?: string;
	adapter?: string;
	prompt?: string;
	print: boolean;
	json: boolean;
	listAgents: boolean;
	sessions: boolean;
	exportSession?: string;
	help: boolean;
	version: boolean;
	yolo: boolean;
}

const VERSION = "0.1.0";

async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv);
	if (args.help) {
		printHelp();
		return;
	}
	if (args.version) {
		console.log(VERSION);
		return;
	}

	const config = loadTreeConfig({ configPath: args.configPath });
	const envLoad = applyWorkspaceEnv(config.cwd);
	if (args.adapter) config.defaultAdapter = args.adapter;
	if (args.yolo) applyYoloConfig(config);
	const runtime = createRuntimeHost(config.runtime);
	const sessionStore = new SessionStore(config.sessionDir);
	const adapters = createDefaultAdapters();

	if (args.sessions) {
		const sessions = await sessionStore.list();
		for (const session of sessions) {
			console.log(
				`${session.id.slice(0, 8)}\t${session.modifiedAt}\t${session.name ?? ""}\t${session.firstMessage ?? ""}`,
			);
		}
		return;
	}

	if (args.exportSession) {
		const loaded = await sessionStore.load(args.exportSession);
		const target = resolve(
			config.cwd,
			`tree-session-${loaded.header.id.slice(0, 8)}.md`,
		);
		await writeFile(target, sessionStore.toMarkdown(loaded), "utf8");
		console.log(target);
		return;
	}

	const pipedPrompt = !process.stdin.isTTY ? await readStdin() : undefined;
	const prompt = args.prompt ?? pipedPrompt;
	let agnoSidecar: ManagedSidecar | undefined = await maybeStartAgnoSidecar(
		config,
		runtime,
	);
	try {
		if (args.listAgents) {
			await listAgents(config, runtime, adapters);
			return;
		}

		if (args.print || !process.stdin.isTTY) {
			if (!prompt) throw new Error("Print mode needs a prompt or stdin.");
			await runPrint(
				config,
				runtime,
				sessionStore,
				adapters,
				prompt,
				args.json,
			);
			return;
		}

		const startupNotices: string[] = [];
		if (envLoad.loaded.length > 0) {
			startupNotices.push(
				`loaded ${envLoad.loaded.length} env var(s) from ${envLoad.path}`,
			);
		}
		if (agnoSidecar?.notice) startupNotices.push(agnoSidecar.notice);
		if (args.yolo) {
			startupNotices.push(
				"YOLO mode · approvals auto-accepted, sandbox disabled. Tools run unrestricted.",
			);
		}
		const app = new TreeTuiApp({
			config,
			runtime,
			adapters,
			sessionStore,
			initialPrompt: prompt,
			yolo: args.yolo,
			startupNotices,
			onAdapterActivated: async (adapterId) => {
				if (adapterId !== "agno" || agnoSidecar) return undefined;
				agnoSidecar = await startAgnoSidecar(config, runtime);
				return agnoSidecar?.notice;
			},
			onWorkspaceEnvChanged: async ({ activeAdapter }) => {
				if (activeAdapter !== "agno") return undefined;
				await agnoSidecar?.stop();
				agnoSidecar = await startAgnoSidecar(config, runtime);
				return restartNotice(agnoSidecar?.notice);
			},
		});
		await app.run();
	} finally {
		await agnoSidecar?.stop();
	}
}

function restartNotice(notice: string | undefined): string {
	if (!notice) return "Agno AgentOS auto-start is disabled.";
	if (notice.startsWith("started "))
		return notice.replace("started ", "restarted ");
	if (notice.startsWith("using existing ")) {
		return notice.replace("using existing ", "reconnected to existing ");
	}
	return notice;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		print: false,
		json: false,
		listAgents: false,
		sessions: false,
		help: false,
		version: false,
		yolo: false,
	};
	const prompt: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				args.help = true;
				break;
			case "--version":
				args.version = true;
				break;
			case "-c":
			case "--config":
				args.configPath = argv[++i];
				break;
			case "-a":
			case "--adapter":
				args.adapter = argv[++i];
				break;
			case "-p":
			case "--print":
				args.print = true;
				break;
			case "--json":
				args.json = true;
				args.print = true;
				break;
			case "--list-agents":
				args.listAgents = true;
				break;
			case "--sessions":
				args.sessions = true;
				break;
			case "-y":
			case "--yolo":
				args.yolo = true;
				break;
			case "--export":
				args.exportSession = argv[++i];
				break;
			case "--":
				prompt.push(...argv.slice(i + 1));
				i = argv.length;
				break;
			default:
				prompt.push(arg);
		}
	}
	if (prompt.length > 0) args.prompt = prompt.join(" ");
	return args;
}

function printHelp(): void {
	console.log(`tree-agent ${VERSION}

Usage:
  bun run dev                         Start the interactive TUI (codex by default)
  bun run dev -- --adapter claude     Override the default adapter
  bun run dev -- --print "prompt"     Run once and print output
  bun run dev -- --list-agents        List agents for the active adapter
  bun run dev -- --sessions           List local sessions
  bun run dev -- --export <id|file>   Export a session to Markdown
  bun run dev -- --yolo               Run the adapter unrestricted
                                        (codex: danger-full-access sandbox,
                                         claude: bypassPermissions,
                                         others: auto-approve all approvals)

Interactive commands:
  /new /resume [id] /adapter [id] /model [name] /fast /set /image /agents /permissions /cancel
  /sessions /tree /fork [entryId] /export [file] /approve <id> /reject <id> /help
`);
}

function applyYoloConfig(config: TreeConfig): void {
	config.adapters.codex = {
		...(config.adapters.codex ?? { mode: "app-server" }),
		sandbox: "danger-full-access",
	};
	config.adapters.claude = {
		...(config.adapters.claude ?? {}),
		permissionMode: "bypassPermissions",
		disallowedTools: [],
	};
}

async function readStdin(): Promise<string | undefined> {
	let data = "";
	for await (const chunk of process.stdin) data += chunk;
	return data.trim() || undefined;
}

async function listAgents(
	config: TreeConfig,
	runtime: RuntimeHost,
	adapters: Map<string, AgentAdapter>,
): Promise<void> {
	const adapter = adapters.get(String(config.defaultAdapter));
	if (!adapter) throw new Error(`Unknown adapter ${config.defaultAdapter}`);
	const agents = await adapter.listAgents({ config, runtime, cwd: config.cwd });
	for (const agent of agents) {
		console.log(
			`${agent.id}\t${agent.name}\t${agent.provider ?? ""}\t${agent.model ?? ""}`,
		);
	}
}

async function runPrint(
	config: TreeConfig,
	runtime: RuntimeHost,
	sessionStore: SessionStore,
	adapters: Map<string, AgentAdapter>,
	prompt: string,
	json: boolean,
): Promise<void> {
	const adapter = adapters.get(String(config.defaultAdapter));
	if (!adapter) throw new Error(`Unknown adapter ${config.defaultAdapter}`);
	const session = await sessionStore.create({
		cwd: config.cwd,
		adapterId: adapter.id,
		name: "print run",
	});
	const adapterSession = await adapter.startSession({
		config,
		runtime,
		cwd: config.cwd,
	});
	const userEntry = await sessionStore.append(session.path, {
		type: "message",
		parentId: session.leafId,
		role: "user",
		content: prompt,
	});
	session.leafId = userEntry.id;
	for await (const event of adapter.sendMessage(
		adapterSession,
		{ content: prompt },
		{ config, runtime, cwd: config.cwd },
	)) {
		const eventEntry = await sessionStore.append(session.path, {
			type: "event",
			parentId: session.leafId,
			event,
		});
		session.leafId = eventEntry.id;
		if (json) console.log(JSON.stringify(event));
		else printEvent(event);
	}
}

function printEvent(event: TreeEvent): void {
	if (event.type === "assistant_delta" || event.type === "assistant_message")
		process.stdout.write(event.text);
	else if (event.type === "run_error") console.error(event.message);
	else if (event.type === "approval_requested")
		console.error(
			`\nApproval required: ${event.approvalId ?? event.toolCallId ?? event.runId}`,
		);
}

main(process.argv.slice(2)).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
