import { describe, expect, test } from "bun:test";
import { createRuntimeHost } from "../src/runtime-host.ts";

describe("RuntimeHost", () => {
	test("executes commands and exposes selected runtime kind", async () => {
		const host = createRuntimeHost("auto");
		const result = await host.exec("node", ["--version"]);
		expect(result.exitCode).toBe(0);
		expect(["bun", "node"]).toContain(host.kind);
	});
});
