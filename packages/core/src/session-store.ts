import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AdapterId, TreeEvent } from "./types.js";

export interface SessionHeader {
	type: "session";
	version: 1;
	id: string;
	cwd: string;
	createdAt: string;
	name?: string;
	adapterId?: AdapterId;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export type SessionEntry =
	| (SessionEntryBase & {
			type: "message";
			role: "user" | "assistant" | "system";
			content: string;
	  })
	| (SessionEntryBase & { type: "event"; event: TreeEvent })
	| (SessionEntryBase & { type: "label"; targetId: string; label?: string })
	| (SessionEntryBase & { type: "session_info"; name?: string })
	| (SessionEntryBase & {
			type: "adapter_state";
			adapterId: AdapterId;
			data: Record<string, unknown>;
	  });

export type NewSessionEntry =
	| {
			type: "message";
			parentId: string | null;
			role: "user" | "assistant" | "system";
			content: string;
			id?: string;
			timestamp?: string;
	  }
	| {
			type: "event";
			parentId: string | null;
			event: TreeEvent;
			id?: string;
			timestamp?: string;
	  }
	| {
			type: "label";
			parentId: string | null;
			targetId: string;
			label?: string;
			id?: string;
			timestamp?: string;
	  }
	| {
			type: "session_info";
			parentId: string | null;
			name?: string;
			id?: string;
			timestamp?: string;
	  }
	| {
			type: "adapter_state";
			parentId: string | null;
			adapterId: AdapterId;
			data: Record<string, unknown>;
			id?: string;
			timestamp?: string;
	  };

export interface LoadedSession {
	header: SessionHeader;
	entries: SessionEntry[];
	path: string;
	leafId: string | null;
}

export interface SessionInfo {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage?: string;
}

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
}

export class SessionStore {
	constructor(readonly dir: string) {}

	async ensure(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
	}

	async create(options: {
		cwd: string;
		name?: string;
		adapterId?: AdapterId;
		parentSession?: string;
	}): Promise<LoadedSession> {
		await this.ensure();
		const header: SessionHeader = {
			type: "session",
			version: 1,
			id: randomUUID(),
			cwd: resolve(options.cwd),
			createdAt: new Date().toISOString(),
			name: options.name,
			adapterId: options.adapterId,
			parentSession: options.parentSession,
		};
		const path = this.pathFor(header.id);
		await writeFile(path, `${JSON.stringify(header)}\n`, "utf8");
		return { header, entries: [], path, leafId: null };
	}

	async load(pathOrId: string): Promise<LoadedSession> {
		const path = pathOrId.endsWith(".jsonl")
			? pathOrId
			: this.pathFor(pathOrId);
		const text = await readFile(path, "utf8");
		const lines = text
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as SessionHeader | SessionEntry);
		const header = lines[0] as SessionHeader;
		const entries = lines.slice(1) as SessionEntry[];
		return { header, entries, path, leafId: entries.at(-1)?.id ?? null };
	}

	async list(): Promise<SessionInfo[]> {
		await this.ensure();
		const files = await readdir(this.dir);
		const sessions: SessionInfo[] = [];
		for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
			const path = join(this.dir, file);
			try {
				const loaded = await this.load(path);
				const fileStat = await stat(path);
				const firstMessage = loaded.entries.find(
					(entry) => entry.type === "message" && entry.role === "user",
				) as (SessionEntry & { type: "message"; content: string }) | undefined;
				sessions.push({
					id: loaded.header.id,
					path,
					cwd: loaded.header.cwd,
					name: loaded.header.name,
					createdAt: loaded.header.createdAt,
					modifiedAt: fileStat.mtime.toISOString(),
					messageCount: loaded.entries.filter(
						(entry) => entry.type === "message",
					).length,
					firstMessage: firstMessage?.content,
				});
			} catch {}
		}
		return sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
	}

	async append(path: string, entry: NewSessionEntry): Promise<SessionEntry> {
		const fullEntry = {
			id: entry.id ?? randomUUID(),
			timestamp: entry.timestamp ?? new Date().toISOString(),
			...entry,
		} as SessionEntry;
		await appendFile(path, `${JSON.stringify(fullEntry)}\n`, "utf8");
		return fullEntry;
	}

	async fork(
		source: LoadedSession,
		fromEntryId: string | null,
		options: { name?: string } = {},
	): Promise<LoadedSession> {
		const forked = await this.create({
			cwd: source.header.cwd,
			name:
				options.name ??
				`Fork of ${source.header.name ?? source.header.id.slice(0, 8)}`,
			adapterId: source.header.adapterId,
			parentSession: source.path,
		});
		const branch = fromEntryId
			? this.branchTo(source.entries, fromEntryId)
			: source.entries;
		for (const entry of branch) {
			await appendFile(forked.path, `${JSON.stringify(entry)}\n`, "utf8");
		}
		return this.load(forked.path);
	}

	tree(entries: SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];
		for (const entry of entries) nodes.set(entry.id, { entry, children: [] });
		for (const entry of entries) {
			const node = nodes.get(entry.id);
			if (!node) continue;
			const parent = entry.parentId ? nodes.get(entry.parentId) : undefined;
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
		return roots;
	}

	branchTo(entries: SessionEntry[], leafId: string): SessionEntry[] {
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const branch: SessionEntry[] = [];
		let current: string | null | undefined = leafId;
		while (current) {
			const entry = byId.get(current);
			if (!entry) break;
			branch.push(entry);
			current = entry.parentId;
		}
		return branch.reverse();
	}

	toMarkdown(session: LoadedSession): string {
		const lines = [
			`# ${session.header.name ?? `Session ${session.header.id}`}`,
			"",
			`- cwd: ${session.header.cwd}`,
			"",
		];
		for (const entry of session.entries) {
			if (entry.type === "message") {
				lines.push(`## ${entry.role}`, "", entry.content, "");
			} else if (
				entry.type === "event" &&
				entry.event.type === "tool_started"
			) {
				lines.push(
					`### tool: ${entry.event.name}`,
					"",
					"```json",
					JSON.stringify(entry.event.args ?? {}, null, 2),
					"```",
					"",
				);
			}
		}
		return lines.join("\n");
	}

	pathFor(id: string): string {
		return join(this.dir, `${id}.jsonl`);
	}

	exists(id: string): boolean {
		return existsSync(this.pathFor(id));
	}
}
