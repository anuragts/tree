export type RuntimePreference = "bun" | "node" | "auto";

export type AdapterId = "agno" | "claude" | "codex" | string;

export interface TreeConfig {
	runtime: RuntimePreference;
	defaultAdapter: AdapterId;
	cwd: string;
	sessionDir: string;
	adapters: {
		agno?: AgnoAdapterConfig;
		claude?: ClaudeAdapterConfig;
		codex?: CodexAdapterConfig;
		[name: string]: unknown;
	};
}

export interface AgnoAdapterConfig {
	baseUrl: string;
	agentId: string;
	authToken?: string;
	sidecarCommand?: string;
	sidecarAutoStart?: boolean;
	sidecarCwd?: string;
	sidecarHost?: string;
	sidecarPort?: number;
	userId?: string;
}

export interface ClaudeAdapterConfig {
	model?: string;
	allowedTools?: string[];
	disallowedTools?: string[];
	permissionMode?: string;
	cwd?: string;
	fastMode?: boolean;
}

export interface CodexAdapterConfig {
	mode: "app-server" | "exec" | "mcp";
	model?: string;
	sandbox?: string;
	cwd?: string;
	fastMode?: boolean;
}

export interface AgentSummary {
	id: string;
	name: string;
	description?: string;
	model?: string;
	provider?: string;
	metadata?: Record<string, unknown>;
}

export interface AdapterSession {
	id: string;
	adapterId: AdapterId;
	agentId?: string;
	runId?: string;
	cwd: string;
	metadata?: Record<string, unknown>;
}

export interface SendMessageInput {
	content: string;
	images?: Array<{ path: string; mimeType?: string }>;
	files?: Array<{ path: string; mimeType?: string }>;
}

export type TreeEvent =
	| {
			type: "run_started";
			runId: string;
			sessionId: string;
			adapterId: AdapterId;
			agentId?: string;
			model?: string;
	  }
	| { type: "assistant_delta"; text: string; runId?: string }
	| { type: "assistant_message"; text: string; runId?: string }
	| {
			type: "tool_started";
			toolCallId: string;
			name: string;
			args?: unknown;
			runId?: string;
	  }
	| {
			type: "tool_completed";
			toolCallId: string;
			name: string;
			result?: unknown;
			isError?: boolean;
			runId?: string;
	  }
	| {
			type: "approval_requested";
			approvalId?: string;
			runId: string;
			sessionId?: string;
			toolCallId?: string;
			toolName?: string;
			toolArgs?: unknown;
			pauseType?: string;
			source?: string;
	  }
	| {
			type: "run_paused";
			runId: string;
			reason?: string;
			approvals?: unknown[];
	  }
	| {
			type: "run_completed";
			runId: string;
			sessionId?: string;
			usage?: UsageInfo;
			status?: string;
	  }
	| { type: "run_error"; message: string; runId?: string; cause?: unknown }
	| { type: "usage"; usage: UsageInfo; runId?: string }
	| {
			type: "log";
			level: "debug" | "info" | "warn" | "error";
			message: string;
			details?: unknown;
	  };

export interface UsageInfo {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	costUsd?: number;
}

export interface ContinueRunInput {
	runId: string;
	sessionId?: string;
	approvalId?: string;
	approved?: boolean;
	toolResults?: unknown[];
	resolutionData?: Record<string, unknown>;
}

export interface AgentAdapter {
	id: AdapterId;
	displayName: string;
	listAgents(context: AdapterContext): Promise<AgentSummary[]>;
	startSession(
		context: AdapterContext,
		agentId?: string,
	): Promise<AdapterSession>;
	sendMessage(
		session: AdapterSession,
		input: SendMessageInput,
		context: AdapterContext,
	): AsyncIterable<TreeEvent>;
	continueRun?(
		session: AdapterSession,
		input: ContinueRunInput,
		context: AdapterContext,
	): AsyncIterable<TreeEvent>;
	cancelRun?(
		session: AdapterSession,
		runId: string,
		context: AdapterContext,
	): Promise<void>;
	dispose?(): Promise<void>;
}

export interface AdapterContext {
	config: TreeConfig;
	runtime: RuntimeHost;
	cwd: string;
}

export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
}

export interface SpawnHandle {
	pid?: number;
	stdout: AsyncIterable<string>;
	stderr: AsyncIterable<string>;
	writeStdin(data: string): void;
	closeStdin(): void;
	kill(signal?: NodeJS.Signals | number): void;
	exitCode: Promise<number | null>;
}

export interface ExecResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface RuntimeHost {
	kind: "bun" | "node";
	cwd(): string;
	env(name: string): string | undefined;
	which(command: string): Promise<string | null>;
	spawn(command: string, args: string[], options?: SpawnOptions): SpawnHandle;
	exec(
		command: string,
		args: string[],
		options?: SpawnOptions & { timeoutMs?: number },
	): Promise<ExecResult>;
}
