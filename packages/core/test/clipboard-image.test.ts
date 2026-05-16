import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClipboardCommandRunner,
	readClipboardImage,
	saveClipboardImageAttachment,
} from "../src/clipboard-image.ts";

function ok(stdout: Buffer | string): ReturnType<ClipboardCommandRunner> {
	return {
		ok: true,
		stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"),
	};
}

function fail(): ReturnType<ClipboardCommandRunner> {
	return { ok: false, stdout: Buffer.alloc(0) };
}

describe("clipboard images", () => {
	test("macOS reads an image through osascript", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tree-clip-"));
		try {
			const runCommand: ClipboardCommandRunner = asyncCommand(
				(command, args) => {
					expect(command).toBe("osascript");
					const outputPath = args.at(-1);
					if (!outputPath) throw new Error("missing output path");
					writeFileSync(outputPath, Buffer.from([1, 2, 3]));
					return ok("ok\n");
				},
			);
			const image = await readClipboardImage({
				platform: "darwin",
				tmpDir: dir,
				runCommand,
			});
			expect(image?.mimeType).toBe("image/png");
			expect(Array.from(image?.bytes ?? [])).toEqual([1, 2, 3]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("Wayland chooses a preferred image MIME type", async () => {
		const runCommand: ClipboardCommandRunner = asyncCommand((command, args) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return ok("text/plain\nimage/jpeg\nimage/png\n");
			}
			if (command === "wl-paste" && args[0] === "--type") {
				expect(args[1]).toBe("image/png");
				return ok(Buffer.from([4, 5]));
			}
			return fail();
		});
		const image = await readClipboardImage({
			platform: "linux",
			env: { WAYLAND_DISPLAY: "1" },
			runCommand,
		});
		expect(image?.mimeType).toBe("image/png");
		expect(Array.from(image?.bytes ?? [])).toEqual([4, 5]);
	});

	test("saves clipboard image attachments to the requested directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tree-clip-"));
		try {
			const runCommand: ClipboardCommandRunner = asyncCommand(
				(_command, args) => {
					const outputPath = args.at(-1);
					if (!outputPath) throw new Error("missing output path");
					writeFileSync(outputPath, Buffer.from([7, 8, 9]));
					return ok("ok\n");
				},
			);
			const attachment = await saveClipboardImageAttachment({
				platform: "darwin",
				tmpDir: dir,
				outputDir: dir,
				runCommand,
			});
			expect(attachment?.mimeType).toBe("image/png");
			expect(attachment?.sizeBytes).toBe(3);
			expect(attachment?.path.endsWith(".png")).toBe(true);
			expect(Array.from(await readFile(attachment?.path ?? ""))).toEqual([
				7, 8, 9,
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

function asyncCommand(
	fn: (command: string, args: string[]) => ReturnType<ClipboardCommandRunner>,
): ClipboardCommandRunner {
	return (command, args) => fn(command, args);
}
