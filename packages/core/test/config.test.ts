import { describe, expect, test } from "bun:test";
import { parseTomlSubset } from "../src/config.ts";

describe("parseTomlSubset", () => {
	test("parses root keys and nested adapter sections", () => {
		const parsed = parseTomlSubset(`
runtime = "bun"
defaultAdapter = "agno"

[adapters.agno]
baseUrl = "http://localhost:8000"
agentId = "workbench"

[adapters.claude]
allowedTools = ["Read", "Edit", "Bash"]
`);
		expect(parsed.runtime).toBe("bun");
		expect(parsed.defaultAdapter).toBe("agno");
		const adapters = parsed.adapters as Record<
			string,
			{ baseUrl?: string; allowedTools?: string[] }
		>;
		expect(adapters.agno?.baseUrl).toBe("http://localhost:8000");
		expect(adapters.claude?.allowedTools).toEqual(["Read", "Edit", "Bash"]);
	});
});
