import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyWorkspaceEnv,
	parseEnvFile,
	writeWorkspaceEnvValue,
} from "../src/env.ts";

describe("workspace env", () => {
	test("parses common .env syntax", () => {
		expect(
			parseEnvFile(`
OPENAI_API_KEY=sk-test
ANTHROPIC_API_KEY="anthropic # not a comment"
export TREE_AGNO_MODEL=anthropic:claude-opus-4-7 # local default
IGNORED LINE
`),
		).toEqual({
			OPENAI_API_KEY: "sk-test",
			ANTHROPIC_API_KEY: "anthropic # not a comment",
			TREE_AGNO_MODEL: "anthropic:claude-opus-4-7",
		});
	});

	test("writes .env and protects it with .gitignore", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tree-env-"));
		try {
			await writeWorkspaceEnvValue(dir, "OPENAI_API_KEY", "first");
			await writeWorkspaceEnvValue(dir, "OPENAI_API_KEY", "second");
			await writeWorkspaceEnvValue(dir, "ANTHROPIC_API_KEY", "third");

			const env = await readFile(join(dir, ".env"), "utf8");
			expect(env).toContain("OPENAI_API_KEY=second\n");
			expect(env.match(/OPENAI_API_KEY=/g)?.length).toBe(1);
			expect(env).toContain("ANTHROPIC_API_KEY=third\n");

			const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
			expect(gitignore).toContain(".env\n");
			expect(gitignore).toContain(".env.*\n");
			expect(gitignore).toContain("!.env.example\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("loads .env without overriding shell env", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tree-env-"));
		const key = "TREE_ENV_TEST_VALUE";
		const previous = process.env[key];
		try {
			await writeFile(join(dir, ".env"), `${key}=from-file\n`, "utf8");
			process.env[key] = "from-shell";
			const result = applyWorkspaceEnv(dir);
			expect(result.skipped).toEqual([key]);
			expect(process.env[key]).toBe("from-shell");
		} finally {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
