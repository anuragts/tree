import { randomUUID } from "node:crypto";
import {
	type AdapterContext,
	type AdapterSession,
	type AgentAdapter,
	type AgentSummary,
	type ContinueRunInput,
	parseSseStream,
	type SendMessageInput,
	type TreeEvent,
} from "@tree/core";
import { normalizeAgnoSse } from "./normalize.js";

export class AgnoAdapter implements AgentAdapter {
	readonly id = "agno";
	readonly displayName = "Agno AgentOS";

	async listAgents(context: AdapterContext): Promise<AgentSummary[]> {
		const response = await fetch(this.url(context, "/agents"), {
			headers: this.headers(context),
		});
		if (!response.ok) {
			throw new Error(
				`Agno /agents failed: ${response.status} ${await response.text()}`,
			);
		}
		const agents = (await response.json()) as Array<Record<string, unknown>>;
		return agents.map((agent) => ({
			id: String(agent.id),
			name: String(agent.name ?? agent.id),
			description:
				typeof agent.description === "string" ? agent.description : undefined,
			model: modelField(agent.model, "model"),
			provider: modelField(agent.model, "provider"),
			metadata: agent,
		}));
	}

	async startSession(
		context: AdapterContext,
		agentId?: string,
	): Promise<AdapterSession> {
		const config = context.config.adapters.agno;
		return {
			id: randomUUID(),
			adapterId: this.id,
			agentId: agentId ?? config?.agentId ?? "workbench",
			cwd: context.cwd,
		};
	}

	async *sendMessage(
		session: AdapterSession,
		input: SendMessageInput,
		context: AdapterContext,
	): AsyncIterable<TreeEvent> {
		const agentId =
			session.agentId ?? context.config.adapters.agno?.agentId ?? "workbench";
		const form = new FormData();
		form.set("message", input.content);
		form.set("stream", "true");
		form.set("session_id", session.id);
		const userId = context.config.adapters.agno?.userId;
		if (userId) form.set("user_id", userId);
		yield* this.postRun(
			context,
			`/agents/${encodeURIComponent(agentId)}/runs`,
			form,
			session,
		);
	}

	async *continueRun(
		session: AdapterSession,
		input: ContinueRunInput,
		context: AdapterContext,
	): AsyncIterable<TreeEvent> {
		const agentId =
			session.agentId ?? context.config.adapters.agno?.agentId ?? "workbench";
		if (input.approvalId) {
			const status = input.approved === false ? "rejected" : "approved";
			const approvalResponse = await fetch(
				this.url(
					context,
					`/approvals/${encodeURIComponent(input.approvalId)}/resolve`,
				),
				{
					method: "POST",
					headers: {
						...this.headers(context),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						status,
						resolved_by: "tree",
						resolution_data: input.resolutionData,
					}),
				},
			);
			if (!approvalResponse.ok) {
				yield {
					type: "run_error",
					runId: input.runId,
					message: `Failed to resolve approval ${input.approvalId}: ${approvalResponse.status} ${await approvalResponse.text()}`,
				};
				return;
			}
		}
		const form = new FormData();
		form.set("stream", "true");
		form.set("session_id", input.sessionId ?? session.id);
		form.set(
			"tools",
			input.toolResults ? JSON.stringify(input.toolResults) : "",
		);
		yield* this.postRun(
			context,
			`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(input.runId)}/continue`,
			form,
			session,
		);
	}

	async cancelRun(
		session: AdapterSession,
		runId: string,
		context: AdapterContext,
	): Promise<void> {
		const agentId =
			session.agentId ?? context.config.adapters.agno?.agentId ?? "workbench";
		const response = await fetch(
			this.url(
				context,
				`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
			),
			{
				method: "POST",
				headers: this.headers(context),
			},
		);
		if (!response.ok) {
			throw new Error(
				`Agno cancel failed: ${response.status} ${await response.text()}`,
			);
		}
	}

	private async *postRun(
		context: AdapterContext,
		path: string,
		form: FormData,
		session: AdapterSession,
	): AsyncIterable<TreeEvent> {
		const response = await fetch(this.url(context, path), {
			method: "POST",
			headers: this.headers(context),
			body: form,
		});
		if (!response.ok || !response.body) {
			yield {
				type: "run_error",
				message: `Agno request failed: ${response.status} ${await response.text()}`,
			};
			return;
		}
		for await (const message of parseSseStream(response.body)) {
			for (const event of normalizeAgnoSse(message)) {
				if (event.type === "run_started") session.runId = event.runId;
				yield event;
			}
		}
	}

	private url(context: AdapterContext, path: string): string {
		const baseUrl =
			context.config.adapters.agno?.baseUrl ?? "http://localhost:8000";
		return `${baseUrl.replace(/\/$/, "")}${path}`;
	}

	private headers(context: AdapterContext): Record<string, string> {
		const authToken = context.config.adapters.agno?.authToken;
		return authToken ? { Authorization: `Bearer ${authToken}` } : {};
	}
}

function modelField(model: unknown, field: string): string | undefined {
	if (!model || typeof model !== "object") return undefined;
	const value = (model as Record<string, unknown>)[field];
	return typeof value === "string" ? value : undefined;
}
