import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	type SlashCommand,
	Spacer,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import type {
	AdapterContext,
	AdapterSession,
	AgentAdapter,
	ContinueRunInput,
	LoadedSession,
	RuntimeHost,
	SessionEntry,
	SessionStore,
	TreeConfig,
	TreeEvent,
} from "@tree/core";
import { WelcomeBanner } from "./banner.js";
import { Footer } from "./footer.js";
import { chalk, editorTheme, markdownTheme, palette, role } from "./theme.js";
import { renderSessionTree } from "./tree-text.js";

export interface TreeTuiOptions {
	config: TreeConfig;
	runtime: RuntimeHost;
	adapters: Map<string, AgentAdapter>;
	sessionStore: SessionStore;
	initialPrompt?: string;
	startupNotices?: string[];
	yolo?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "new", description: "Start a fresh session", argumentHint: "[name]" },
	{ name: "clear", description: "Clear the screen (keep the session)" },
	{ name: "sessions", description: "List recent local sessions" },
	{
		name: "resume",
		description: "Resume a session by id prefix",
		argumentHint: "<id>",
	},
	{ name: "tree", description: "Show the session tree" },
	{
		name: "fork",
		description: "Fork from an entry (defaults to leaf)",
		argumentHint: "[entryId]",
	},
	{
		name: "export",
		description: "Export the current session to markdown",
		argumentHint: "[file]",
	},
	{
		name: "adapter",
		description: "List or switch the active adapter",
		argumentHint: "[id]",
	},
	{ name: "agents", description: "List agents for the active adapter" },
	{ name: "permissions", description: "Show adapter permissions" },
	{ name: "cancel", description: "Cancel the active run" },
	{
		name: "approve",
		description: "Approve a pending tool call",
		argumentHint: "<id>",
	},
	{
		name: "reject",
		description: "Reject a pending tool call",
		argumentHint: "<id>",
	},
	{ name: "help", description: "Show this command list" },
];

export class TreeTuiApp {
	private readonly terminal = new ProcessTerminal();
	private readonly ui = new TUI(this.terminal);
	private readonly root = new Container();
	private readonly messages = new Container();
	private readonly status = new Container();
	private readonly editor = new Editor(this.ui, editorTheme, { paddingX: 1 });
	private readonly footer: Footer;
	private session?: LoadedSession;
	private adapterSession?: AdapterSession;
	private activeAdapter: string;
	private working = false;
	private currentRunId?: string;
	private statusLoader?: Loader;
	private activeAssistant?: Text;
	private activeAssistantText = "";
	private pendingApprovals = new Map<string, ContinueRunInput>();
	private awaitingApproval?: string;
	private approvalLabels = new Map<string, string>();
	private readonly done: Promise<void>;
	private resolveDone!: () => void;
	private stopped = false;

	constructor(private readonly options: TreeTuiOptions) {
		this.activeAdapter = String(options.config.defaultAdapter);
		this.done = new Promise((resolveDone) => {
			this.resolveDone = resolveDone;
		});
		this.footer = new Footer(
			() => ({
				config: options.config,
				activeAdapter: this.activeAdapter,
				sessionId: this.session?.header.id,
				adapterSession: this.adapterSession,
				working: this.working,
				runId: this.currentRunId,
				messageCount:
					this.session?.entries.filter((entry) => entry.type === "message")
						.length ?? 0,
				runtimeKind: options.runtime.kind,
			}),
			() => this.ui.requestRender(),
		);
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(SLASH_COMMANDS, options.config.cwd),
		);
	}

	async run(): Promise<void> {
		this.root.addChild(this.headerLine());
		this.root.addChild(new Spacer(1));
		this.root.addChild(this.messages);
		this.root.addChild(this.status);
		this.root.addChild(new Spacer(1));
		this.root.addChild(this.editor);
		this.root.addChild(new Spacer(1));
		this.root.addChild(this.footer);
		this.ui.addChild(this.root);
		this.ui.setFocus(this.editor);
		this.editor.onSubmit = (text) => {
			void this.handleSubmit(text);
		};
		this.ui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c")) {
				void this.stop();
			}
			return undefined;
		});
		this.ui.start();
		this.showStartup();
		if (this.options.initialPrompt) {
			await this.handleSubmit(this.options.initialPrompt);
		}
		return this.done;
	}

	private headerLine(): Text {
		const brand = chalk.bold.hex(palette.leaf)("🌿 tree");
		const hint = chalk.hex(palette.subtle)(
			"  /help for commands · ctrl-c to exit",
		);
		return new Text(brand + hint, 0, 0);
	}

	private async handleSubmit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.awaitingApproval) {
			const verdict = parseApprovalAnswer(trimmed);
			if (verdict !== undefined) {
				const id = this.awaitingApproval;
				await this.resolveApproval(id, verdict);
				return;
			}
		}
		if (trimmed.startsWith("/")) {
			await this.handleCommand(trimmed);
			return;
		}
		await this.send(trimmed);
	}

	private async send(content: string): Promise<void> {
		await this.ensureSession();
		const adapter = this.requireAdapter();
		this.setWorking(true);
		this.currentRunId = undefined;
		await this.appendMessage("user", content);
		this.adapterSession ??= await adapter.startSession(this.context());
		try {
			for await (const event of adapter.sendMessage(
				this.adapterSession,
				{ content },
				this.context(),
			)) {
				await this.handleEvent(event);
			}
		} catch (error) {
			await this.handleEvent({
				type: "run_error",
				message: error instanceof Error ? error.message : String(error),
				cause: error,
			});
		} finally {
			this.setWorking(false);
			this.activeAssistant = undefined;
			this.activeAssistantText = "";
			this.ui.requestRender();
		}
	}

	private setWorking(working: boolean): void {
		this.working = working;
		this.status.clear();
		this.statusLoader?.stop();
		this.statusLoader = undefined;
		if (working) {
			this.footer.startSpinner();
			this.statusLoader = new Loader(
				this.ui,
				(s) => chalk.hex(palette.yellow)(s),
				(s) => chalk.hex(palette.muted)(s),
				"thinking...",
			);
			this.status.addChild(this.statusLoader);
		} else {
			this.footer.stopSpinner();
		}
		this.ui.requestRender();
	}

	private async handleEvent(event: TreeEvent): Promise<void> {
		if (!this.session) return;
		if (event.type === "run_started") {
			this.currentRunId = event.runId;
			this.adapterSession = {
				...(this.adapterSession ?? {
					id: event.sessionId,
					adapterId: event.adapterId,
					cwd: this.options.config.cwd,
				}),
				runId: event.runId,
			};
		}
		await this.appendEvent(event);
		switch (event.type) {
			case "assistant_delta":
				this.appendAssistantDelta(event.text);
				break;
			case "assistant_message":
				// If we streamed deltas, the assistant bubble is already on screen —
				// just persist the final text to the session store without re-rendering.
				await this.appendMessage("assistant", event.text, {
					render: this.activeAssistant === undefined,
				});
				break;
			case "tool_started": {
				const summary = summarizeTool(event.name, event.args);
				this.messages.addChild(
					new Text(
						role.tool(summary.title) +
							(summary.detail ? chalk.dim(` ${summary.detail}`) : ""),
						0,
						0,
					),
				);
				break;
			}
			case "tool_completed":
				this.messages.addChild(
					new Text(role.toolDone(prettyToolName(event.name)), 0, 0),
				);
				break;
			case "approval_requested": {
				const key = event.approvalId ?? event.toolCallId ?? event.runId;
				this.pendingApprovals.set(key, {
					runId: event.runId,
					sessionId: event.sessionId,
					approvalId: event.approvalId,
					approved: true,
				});
				const summary = summarizeTool(event.toolName ?? "tool", event.toolArgs);
				this.approvalLabels.set(key, summary.title);
				if (this.options.yolo) {
					this.messages.addChild(
						new Text(
							role.toolDone("auto-approved") + chalk.dim(` · ${summary.title}`),
							0,
							0,
						),
					);
					this.ui.requestRender();
					void this.resolveApproval(key, true);
					break;
				}
				this.awaitingApproval = key;
				this.statusLoader?.setMessage(
					"awaiting approval — press y to approve, n to reject",
				);
				this.messages.addChild(new Spacer(1));
				this.messages.addChild(
					new Text(role.warn(`approval required · ${summary.title}`), 0, 0),
				);
				if (summary.detail) {
					this.messages.addChild(
						new Text(chalk.hex(palette.muted)(`  ${summary.detail}`), 0, 0),
					);
				}
				this.messages.addChild(
					new Text(
						chalk.hex(palette.subtle)("  press ") +
							chalk.bold.hex(palette.leaf)("y") +
							chalk.hex(palette.subtle)(" to approve · ") +
							chalk.bold.hex(palette.red)("n") +
							chalk.hex(palette.subtle)(" to reject"),
						0,
						0,
					),
				);
				break;
			}
			case "run_error":
				this.messages.addChild(new Text(role.error(event.message), 0, 0));
				break;
			case "run_completed":
				this.messages.addChild(
					new Text(chalk.hex(palette.subtle)("─── run completed ───"), 0, 0),
				);
				break;
			case "log":
				this.messages.addChild(
					new Text(chalk.dim(`[${event.level}] ${event.message}`), 0, 0),
				);
				break;
			default:
				break;
		}
		this.ui.requestRender();
	}

	private appendAssistantDelta(text: string): void {
		if (!this.activeAssistant) {
			this.messages.addChild(new Spacer(1));
			this.messages.addChild(new Text(role.assistant(), 0, 0));
			this.activeAssistant = new Text("", 0, 0);
			this.messages.addChild(this.activeAssistant);
		}
		this.activeAssistantText += text;
		this.activeAssistant.setText(chalk.white(this.activeAssistantText));
	}

	private async handleCommand(command: string): Promise<void> {
		const [name, ...args] = command.split(/\s+/);
		switch (name) {
			case "/help":
				await this.appendSystem(this.helpText());
				return;
			case "/sessions":
				await this.showSessions();
				return;
			case "/agents":
				await this.showAgents();
				return;
			case "/adapter":
				await this.switchAdapter(args[0]);
				return;
			case "/permissions":
				await this.appendSystem(
					JSON.stringify(
						this.options.config.adapters[this.activeAdapter] ?? {},
						null,
						2,
					),
				);
				return;
			case "/new":
				this.session = await this.options.sessionStore.create({
					cwd: this.options.config.cwd,
					adapterId: this.activeAdapter,
					name: args.join(" ") || "tree session",
				});
				this.adapterSession = undefined;
				this.messages.clear();
				await this.appendSystem(`new session ${this.session.header.id}`);
				return;
			case "/clear":
				this.clearScreen();
				return;
			case "/resume":
				await this.resume(args[0]);
				return;
			case "/tree":
				await this.showTree();
				return;
			case "/fork":
				await this.fork(args[0]);
				return;
			case "/export":
				await this.exportSession(args[0]);
				return;
			case "/cancel":
				await this.cancel();
				return;
			case "/approve":
				await this.resolveApproval(args[0] ?? this.awaitingApproval, true);
				return;
			case "/reject":
				await this.resolveApproval(args[0] ?? this.awaitingApproval, false);
				return;
			default:
				await this.appendSystem(`unknown command: ${name}`);
		}
	}

	private helpText(): string {
		const cmd = (name: string, desc: string): string =>
			chalk.hex(palette.cyan)(name.padEnd(18)) + chalk.hex(palette.muted)(desc);
		const lines = [
			chalk.bold.hex(palette.leaf)("Commands"),
			cmd("/new [name]", "start a fresh session"),
			cmd("/clear", "clear the screen (keep the session)"),
			cmd("/sessions", "list recent sessions"),
			cmd("/resume <id>", "resume a session by id prefix"),
			cmd("/tree", "show the session tree"),
			cmd("/fork [entryId]", "fork from an entry (defaults to leaf)"),
			cmd("/export [file]", "export session to markdown"),
			cmd("/adapter [id]", "list or switch adapter"),
			cmd("/agents", "list agents for the active adapter"),
			cmd("/permissions", "show adapter permissions"),
			cmd("/cancel", "cancel the active run"),
			cmd("y / n", "approve or reject a pending tool call"),
			cmd("/approve [id]", "approve by id (defaults to oldest)"),
			cmd("/reject [id]", "reject by id (defaults to oldest)"),
			cmd("/help", "show this help"),
		];
		return lines.join("\n");
	}

	private clearScreen(): void {
		this.messages.clear();
		this.status.clear();
		this.activeAssistant = undefined;
		this.activeAssistantText = "";
		this.messages.addChild(new Spacer(1));
		this.messages.addChild(new WelcomeBanner(() => this.activeAdapter));
		this.messages.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	private async showAgents(): Promise<void> {
		const adapter = this.requireAdapter();
		try {
			const agents = await adapter.listAgents(this.context());
			await this.appendSystem(
				agents
					.map(
						(agent) =>
							`${chalk.hex(palette.cyan)(agent.id.padEnd(20))} ${chalk.bold(agent.name)}${
								agent.model ? chalk.dim(`  ${agent.model}`) : ""
							}`,
					)
					.join("\n") || "No agents found.",
			);
		} catch (error) {
			await this.appendSystem(
				`Could not list agents: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async switchAdapter(next?: string): Promise<void> {
		if (!next) {
			await this.appendSystem(
				`Adapters: ${Array.from(this.options.adapters.keys()).join(", ")}. Active: ${this.activeAdapter}`,
			);
			return;
		}
		if (!this.options.adapters.has(next)) {
			await this.appendSystem(`No adapter named ${next}`);
			return;
		}
		this.activeAdapter = next;
		this.adapterSession = undefined;
		await this.appendSystem(
			`adapter switched to ${chalk.hex(palette.leaf)(next)}`,
		);
	}

	private async resume(idPrefix?: string): Promise<void> {
		const sessions = await this.options.sessionStore.list();
		if (!idPrefix) {
			await this.showSessions();
			return;
		}
		const match = sessions.find(
			(session) =>
				session.id.startsWith(idPrefix) || session.id.slice(0, 8) === idPrefix,
		);
		if (!match) {
			await this.appendSystem(`No session matches ${idPrefix}`);
			return;
		}
		this.session = await this.options.sessionStore.load(match.path);
		this.adapterSession = undefined;
		this.messages.clear();
		await this.appendSystem(`resumed ${this.session.header.id}`);
		for (const entry of this.session.entries
			.filter((entry) => entry.type === "message")
			.slice(-20)) {
			if (entry.type === "message") {
				this.messages.addChild(new Spacer(1));
				this.messages.addChild(new Text(this.roleHeader(entry.role), 0, 0));
				this.messages.addChild(
					new Markdown(entry.content, 0, 0, markdownTheme),
				);
			}
		}
	}

	private async showTree(): Promise<void> {
		if (!this.session) {
			await this.appendSystem("No active session yet.");
			return;
		}
		const tree = this.options.sessionStore.tree(this.session.entries);
		await this.appendSystem(renderSessionTree(tree, this.session.leafId));
	}

	private async fork(entryId?: string): Promise<void> {
		if (!this.session) {
			await this.appendSystem("No active session yet.");
			return;
		}
		const from = entryId ?? this.session.leafId;
		this.session = await this.options.sessionStore.fork(
			this.session,
			from ?? null,
		);
		this.adapterSession = undefined;
		this.messages.clear();
		await this.appendSystem(`forked to ${this.session.header.id}`);
	}

	private async exportSession(file?: string): Promise<void> {
		if (!this.session) {
			await this.appendSystem("No active session yet.");
			return;
		}
		const target = resolve(
			this.options.config.cwd,
			file ?? `tree-session-${this.session.header.id.slice(0, 8)}.md`,
		);
		await writeFile(
			target,
			this.options.sessionStore.toMarkdown(this.session),
			"utf8",
		);
		await this.appendSystem(`exported ${target}`);
	}

	private async showSessions(): Promise<void> {
		const sessions = await this.options.sessionStore.list();
		await this.appendSystem(
			sessions
				.slice(0, 12)
				.map(
					(session) =>
						`${chalk.hex(palette.cyan)(session.id.slice(0, 8))}  ${chalk.bold(
							session.name ?? "",
						)}  ${chalk.dim(session.firstMessage ?? "")}`,
				)
				.join("\n") || "No sessions.",
		);
	}

	private async cancel(): Promise<void> {
		if (!this.adapterSession?.runId) {
			await this.appendSystem("No active run to cancel.");
			return;
		}
		const adapter = this.requireAdapter();
		if (!adapter.cancelRun) {
			await this.appendSystem(
				`${adapter.displayName} does not support cancellation.`,
			);
			return;
		}
		await adapter.cancelRun(
			this.adapterSession,
			this.adapterSession.runId,
			this.context(),
		);
		await this.appendSystem(`cancelled ${this.adapterSession.runId}`);
	}

	private async resolveApproval(id?: string, approved = true): Promise<void> {
		if (!id) {
			await this.appendSystem(
				`Pending approvals: ${Array.from(this.pendingApprovals.keys()).join(", ") || "none"}`,
			);
			return;
		}
		const input = this.pendingApprovals.get(id);
		if (!input || !this.adapterSession) {
			await this.appendSystem(`No pending approval ${id}`);
			return;
		}
		const adapter = this.requireAdapter();
		if (!adapter.continueRun) {
			await this.appendSystem(
				`${adapter.displayName} does not support continue.`,
			);
			return;
		}
		this.pendingApprovals.delete(id);
		const label = this.approvalLabels.get(id);
		this.approvalLabels.delete(id);
		if (this.awaitingApproval === id) {
			this.awaitingApproval = this.nextPendingApprovalId();
		}
		if (this.awaitingApproval) {
			const nextLabel = this.approvalLabels.get(this.awaitingApproval);
			this.statusLoader?.setMessage(
				nextLabel
					? `awaiting approval — ${nextLabel} (y/n)`
					: "awaiting approval — press y / n",
			);
		} else if (this.working) {
			this.statusLoader?.setMessage("thinking...");
		}
		this.messages.addChild(
			new Text(
				(approved
					? role.toolDone("approved")
					: role.error("rejected")) +
					(label ? chalk.dim(` · ${label}`) : ""),
				0,
				0,
			),
		);
		this.ui.requestRender();
		for await (const event of adapter.continueRun(
			this.adapterSession,
			{ ...input, approved },
			this.context(),
		)) {
			await this.handleEvent(event);
		}
	}

	private nextPendingApprovalId(): string | undefined {
		const first = this.pendingApprovals.keys().next();
		return first.done ? undefined : first.value;
	}

	private roleHeader(roleName: string): string {
		if (roleName === "user") return role.user();
		if (roleName === "assistant") return role.assistant();
		return role.system(roleName);
	}

	private async appendMessage(
		roleName: "user" | "assistant" | "system",
		content: string,
		options: { render?: boolean } = {},
	): Promise<SessionEntry | undefined> {
		if (!this.session) return undefined;
		const entry = await this.options.sessionStore.append(this.session.path, {
			type: "message",
			parentId: this.session.leafId,
			role: roleName,
			content,
		});
		this.session.entries.push(entry);
		this.session.leafId = entry.id;
		if (options.render !== false) {
			this.messages.addChild(new Spacer(1));
			this.messages.addChild(new Text(this.roleHeader(roleName), 0, 0));
			this.messages.addChild(new Markdown(content, 0, 0, markdownTheme));
			this.ui.requestRender();
		}
		return entry;
	}

	private async appendSystem(content: string): Promise<void> {
		this.messages.addChild(new Spacer(1));
		this.messages.addChild(new Text(role.system(), 0, 0));
		this.messages.addChild(new Text(chalk.hex(palette.muted)(content), 0, 0));
		if (this.session) {
			const entry = await this.options.sessionStore.append(this.session.path, {
				type: "message",
				parentId: this.session.leafId,
				role: "system",
				content,
			});
			this.session.entries.push(entry);
			this.session.leafId = entry.id;
		}
		this.ui.requestRender();
	}

	private showStartup(): void {
		this.messages.addChild(new Spacer(1));
		this.messages.addChild(new WelcomeBanner(() => this.activeAdapter));
		this.messages.addChild(new Spacer(1));
		if (this.options.yolo) {
			this.messages.addChild(new Text(role.warn("YOLO mode"), 0, 0));
		}
		for (const notice of this.options.startupNotices ?? []) {
			this.messages.addChild(new Text(chalk.dim(notice), 0, 0));
		}
		this.ui.requestRender();
	}

	private async appendEvent(event: TreeEvent): Promise<void> {
		if (!this.session) return;
		const entry = await this.options.sessionStore.append(this.session.path, {
			type: "event",
			parentId: this.session.leafId,
			event,
		});
		this.session.entries.push(entry);
		this.session.leafId = entry.id;
	}

	private context(): AdapterContext {
		return {
			config: this.options.config,
			runtime: this.options.runtime,
			cwd: this.options.config.cwd,
		};
	}

	private async ensureSession(): Promise<LoadedSession> {
		this.session ??= await this.options.sessionStore.create({
			cwd: this.options.config.cwd,
			adapterId: this.activeAdapter,
			name: "tree session",
		});
		return this.session;
	}

	private requireAdapter(): AgentAdapter {
		const adapter = this.options.adapters.get(this.activeAdapter);
		if (!adapter)
			throw new Error(`No adapter registered for ${this.activeAdapter}`);
		return adapter;
	}

	private async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.statusLoader?.stop();
		this.footer.stopSpinner();
		this.ui.stop();
		for (const adapter of this.options.adapters.values()) {
			await adapter.dispose?.().catch(() => undefined);
		}
		this.resolveDone();
	}
}

function parseApprovalAnswer(input: string): boolean | undefined {
	const lower = input.toLowerCase();
	if (["y", "yes", "approve", "ok", "allow"].includes(lower)) return true;
	if (["n", "no", "reject", "deny", "cancel"].includes(lower)) return false;
	return undefined;
}

function canonicalToolName(name: string): string {
	const match = name.match(/^item\/([a-zA-Z]+)\//);
	if (match) return match[1];
	if (name === "applyPatchApproval") return "fileChange";
	if (name === "execCommandApproval") return "commandExecution";
	return name;
}

function prettyToolName(name: string): string {
	switch (name) {
		case "commandExecution":
			return "command";
		case "fileChange":
			return "edit";
		case "dynamicToolCall":
			return "tool";
		case "mcpToolCall":
			return "mcp tool";
		case "webSearch":
			return "search";
		case "collabToolCall":
			return "collab";
		default:
			return name;
	}
}

interface ToolSummary {
	title: string;
	detail?: string;
}

function summarizeTool(name: string, args: unknown): ToolSummary {
	const canonical = canonicalToolName(name);
	const pretty = prettyToolName(canonical);
	const obj = isRecord(args) ? args : {};
	switch (canonical) {
		case "commandExecution": {
			const command = coerceCommand(obj.command);
			return { title: command ? `ran ${shortCommand(command)}` : pretty, detail: command };
		}
		case "fileChange": {
			const path =
				strProp(obj, "path") ??
				strProp(obj, "file") ??
				summarizeFileList(obj.changes ?? obj.files);
			return { title: path ? `edit ${path}` : pretty, detail: strProp(obj, "reason") };
		}
		case "dynamicToolCall":
		case "mcpToolCall": {
			const toolName = strProp(obj, "name") ?? pretty;
			const argsPreview =
				strProp(obj, "arguments") ?? strProp(obj, "args") ?? jsonPreview(obj.arguments);
			return { title: toolName, detail: argsPreview };
		}
		case "webSearch": {
			const query = strProp(obj, "query");
			return { title: query ? `search "${query}"` : pretty };
		}
		default: {
			const preview = jsonPreview(obj);
			return { title: pretty, detail: preview };
		}
	}
}

function coerceCommand(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value)) {
		const parts = value.filter((v): v is string => typeof v === "string");
		return parts.length > 0 ? parts.join(" ") : undefined;
	}
	return undefined;
}

function shortCommand(cmd: string): string {
	const cleaned = cmd
		.replace(/^\s*\/bin\/(?:zsh|bash|sh)\s+-(?:l?c|c)\s+/, "")
		.replace(/^['"]/, "")
		.replace(/['"]$/, "");
	return truncateLine(cleaned, 100);
}

function summarizeFileList(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const names = value
		.map((item) => (isRecord(item) ? strProp(item, "path") ?? strProp(item, "file") : undefined))
		.filter((v): v is string => Boolean(v));
	if (names.length === 0) return undefined;
	if (names.length === 1) return names[0];
	return `${names[0]} (+${names.length - 1} more)`;
}

function jsonPreview(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (!text || text === "{}" || text === "[]") return undefined;
		return truncateLine(text, 100);
	} catch {
		return undefined;
	}
}

function truncateLine(text: string, max: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= max) return single;
	return `${single.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strProp(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
