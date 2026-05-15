import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store.ts";

describe("SessionStore", () => {
	test("creates append-only branchable sessions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tree-session-"));
		try {
			const store = new SessionStore(dir);
			const session = await store.create({ cwd: dir, adapterId: "agno" });
			const first = await store.append(session.path, {
				type: "message",
				parentId: null,
				role: "user",
				content: "hello",
			});
			const second = await store.append(session.path, {
				type: "message",
				parentId: first.id,
				role: "assistant",
				content: "hi",
			});
			const loaded = await store.load(session.path);
			expect(loaded.entries).toHaveLength(2);
			expect(
				store.branchTo(loaded.entries, second.id).map((entry) => entry.id),
			).toEqual([first.id, second.id]);
			expect(store.tree(loaded.entries)[0].children[0].entry.id).toBe(
				second.id,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
