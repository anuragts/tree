import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageAttachment } from "./types.js";

export interface ClipboardImage {
	bytes: Uint8Array;
	mimeType: string;
}

export interface ClipboardCommandResult {
	ok: boolean;
	stdout: Buffer;
}

export type ClipboardCommandRunner = (
	command: string,
	args: string[],
	options: {
		timeoutMs: number;
		maxBufferBytes: number;
		env?: NodeJS.ProcessEnv;
	},
) => ClipboardCommandResult;

export interface ClipboardImageOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	tmpDir?: string;
	runCommand?: ClipboardCommandRunner;
}

const SUPPORTED_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;
const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

export async function saveClipboardImageAttachment(
	options: ClipboardImageOptions & { outputDir?: string } = {},
): Promise<ImageAttachment | null> {
	const image = await readClipboardImage(options);
	if (!image) return null;
	const outputDir =
		options.outputDir ?? join(options.tmpDir ?? tmpdir(), "tree");
	await mkdir(outputDir, { recursive: true });
	const ext = extensionForImageMimeType(image.mimeType) ?? "png";
	const path = join(outputDir, `clipboard-${randomUUID()}.${ext}`);
	await writeFile(path, image.bytes);
	return { path, mimeType: image.mimeType, sizeBytes: image.bytes.length };
}

export async function readClipboardImage(
	options: ClipboardImageOptions = {},
): Promise<ClipboardImage | null> {
	const env = options.env ?? process.env;
	if (env.TERMUX_VERSION) return null;
	const platform = options.platform ?? process.platform;
	const runCommand = options.runCommand ?? defaultRunCommand;
	const tmpDir = options.tmpDir ?? tmpdir();

	if (platform === "darwin") {
		return (
			readClipboardImageViaMacOs(runCommand, tmpDir, env) ??
			readClipboardImageViaPngpaste(runCommand, env)
		);
	}

	if (platform === "linux") {
		const wayland = isWaylandSession(env);
		const wsl = isWSL(env);
		let image: ClipboardImage | null = null;
		if (wayland || wsl) {
			image =
				readClipboardImageViaWlPaste(runCommand, env) ??
				readClipboardImageViaXclip(runCommand, env);
		}
		if (!image && wsl) {
			image = readClipboardImageViaPowerShell(runCommand, tmpDir, env, true);
		}
		if (!image && !wayland) {
			image = readClipboardImageViaXclip(runCommand, env);
		}
		return image;
	}

	if (platform === "win32") {
		return readClipboardImageViaPowerShell(runCommand, tmpDir, env, false);
	}

	return null;
}

function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function isWSL(env: NodeJS.ProcessEnv): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) return true;
	try {
		const release = readFileSync("/proc/version", "utf8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((type) => type.trim())
		.filter(Boolean)
		.map((raw) => ({ raw, base: baseMimeType(raw) }));
	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((type) => type.base === preferred);
		if (match) return match.raw;
	}
	const anyImage = normalized.find((type) => type.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function defaultRunCommand(
	command: string,
	args: string[],
	options: {
		timeoutMs: number;
		maxBufferBytes: number;
		env?: NodeJS.ProcessEnv;
	},
): ClipboardCommandResult {
	const result = spawnSync(command, args, {
		timeout: options.timeoutMs,
		maxBuffer: options.maxBufferBytes,
		env: options.env,
	});
	if (result.error || result.status !== 0) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}
	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(
				result.stdout ?? "",
				typeof result.stdout === "string" ? "utf8" : undefined,
			);
	return { ok: true, stdout };
}

function runCommand(
	run: ClipboardCommandRunner,
	command: string,
	args: string[],
	options: {
		timeoutMs?: number;
		maxBufferBytes?: number;
		env?: NodeJS.ProcessEnv;
	} = {},
): ClipboardCommandResult {
	return run(command, args, {
		timeoutMs: options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
		maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
		env: options.env,
	});
}

function readClipboardImageViaMacOs(
	run: ClipboardCommandRunner,
	tmpDir: string,
	env: NodeJS.ProcessEnv,
): ClipboardImage | null {
	const path = join(tmpDir, `tree-clipboard-${randomUUID()}.png`);
	const script = `
function run(argv) {
	ObjC.import("AppKit");
	const path = argv[0];
	const pasteboard = $.NSPasteboard.generalPasteboard;
	const image = $.NSImage.alloc.initWithPasteboard(pasteboard);
	if (!image || !image.isValid) return "empty";
	const tiff = image.TIFFRepresentation;
	if (!tiff) return "empty";
	const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
	if (!bitmap) return "empty";
	const png = bitmap.representationUsingTypeProperties(4, $());
	if (!png) return "empty";
	return png.writeToFileAtomically(path, true) ? "ok" : "empty";
}`;
	try {
		const result = runCommand(
			run,
			"osascript",
			["-l", "JavaScript", "-e", script, path],
			{
				env,
				timeoutMs: DEFAULT_READ_TIMEOUT_MS,
			},
		);
		if (!result.ok || !existsSync(path)) return null;
		const bytes = readFileSync(path);
		return bytes.length > 0
			? { bytes: new Uint8Array(bytes), mimeType: "image/png" }
			: null;
	} finally {
		try {
			unlinkSync(path);
		} catch {}
	}
}

function readClipboardImageViaPngpaste(
	run: ClipboardCommandRunner,
	env: NodeJS.ProcessEnv,
): ClipboardImage | null {
	const result = runCommand(run, "pngpaste", ["-"], {
		env,
		timeoutMs: DEFAULT_READ_TIMEOUT_MS,
	});
	return result.ok && result.stdout.length > 0
		? { bytes: new Uint8Array(result.stdout), mimeType: "image/png" }
		: null;
}

function readClipboardImageViaWlPaste(
	run: ClipboardCommandRunner,
	env: NodeJS.ProcessEnv,
): ClipboardImage | null {
	const list = runCommand(run, "wl-paste", ["--list-types"], {
		env,
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});
	if (!list.ok) return null;
	const types = list.stdout
		.toString("utf8")
		.split(/\r?\n/)
		.map((type) => type.trim())
		.filter(Boolean);
	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) return null;
	const data = runCommand(
		run,
		"wl-paste",
		["--type", selectedType, "--no-newline"],
		{
			env,
		},
	);
	return data.ok && data.stdout.length > 0
		? {
				bytes: new Uint8Array(data.stdout),
				mimeType: baseMimeType(selectedType),
			}
		: null;
}

function readClipboardImageViaXclip(
	run: ClipboardCommandRunner,
	env: NodeJS.ProcessEnv,
): ClipboardImage | null {
	const targets = runCommand(
		run,
		"xclip",
		["-selection", "clipboard", "-t", "TARGETS", "-o"],
		{ env, timeoutMs: DEFAULT_LIST_TIMEOUT_MS },
	);
	const types = targets.ok
		? targets.stdout
				.toString("utf8")
				.split(/\r?\n/)
				.map((type) => type.trim())
				.filter(Boolean)
		: [];
	const preferred =
		types.length > 0 ? selectPreferredImageMimeType(types) : null;
	const tryTypes = preferred
		? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES]
		: [...SUPPORTED_IMAGE_MIME_TYPES];
	for (const mimeType of tryTypes) {
		const data = runCommand(
			run,
			"xclip",
			["-selection", "clipboard", "-t", mimeType, "-o"],
			{ env },
		);
		if (data.ok && data.stdout.length > 0) {
			return {
				bytes: new Uint8Array(data.stdout),
				mimeType: baseMimeType(mimeType),
			};
		}
	}
	return null;
}

function readClipboardImageViaPowerShell(
	run: ClipboardCommandRunner,
	tmpDir: string,
	env: NodeJS.ProcessEnv,
	wsl: boolean,
): ClipboardImage | null {
	const tmpFile = join(tmpDir, `tree-clipboard-${randomUUID()}.png`);
	let powerShellPath = tmpFile;
	try {
		if (wsl) {
			const winPath = runCommand(run, "wslpath", ["-w", tmpFile], {
				env,
				timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
			});
			if (!winPath.ok) return null;
			powerShellPath = winPath.stdout.toString("utf8").trim();
			if (!powerShellPath) return null;
		}
		const quotedPath = powerShellPath.replaceAll("'", "''");
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${quotedPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");
		const result = runCommand(
			run,
			"powershell.exe",
			["-NoProfile", "-Command", script],
			{
				env,
				timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
			},
		);
		if (!result.ok || result.stdout.toString("utf8").trim() !== "ok")
			return null;
		const bytes = readFileSync(tmpFile);
		return bytes.length > 0
			? { bytes: new Uint8Array(bytes), mimeType: "image/png" }
			: null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {}
	}
}
