import type {
	EditorTheme,
	MarkdownTheme,
	SelectListTheme,
} from "@earendil-works/pi-tui";
import { Chalk } from "chalk";

export const chalk = new Chalk({ level: 3 });

export const palette = {
	leaf: "#34d399",
	leafBright: "#86efac",
	branch: "#92400e",
	accent: "#a5b4fc",
	cyan: "#67e8f9",
	yellow: "#fbbf24",
	red: "#f87171",
	muted: "#9ca3af",
	subtle: "#52525b",
	dim: "#71717a",
	user: "#c4b5fd",
	assistant: "#34d399",
	system: "#9ca3af",
	tool: "#67e8f9",
};

export const role = {
	user: (label = "you") =>
		chalk.bold.hex(palette.user)("▎ ") + chalk.bold.hex(palette.user)(label),
	assistant: (label = "tree") =>
		chalk.bold.hex(palette.assistant)("▎ ") +
		chalk.bold.hex(palette.assistant)(label),
	system: (label = "system") =>
		chalk.hex(palette.system)("▎ ") + chalk.dim(label),
	tool: (label: string) =>
		chalk.hex(palette.tool)("▸ ") + chalk.bold.hex(palette.tool)(label),
	toolDone: (label: string) =>
		chalk.hex(palette.leaf)("✓ ") + chalk.hex(palette.leaf)(label),
	warn: (label: string) =>
		chalk.hex(palette.yellow)("⚠ ") + chalk.bold.hex(palette.yellow)(label),
	error: (label: string) =>
		chalk.hex(palette.red)("✗ ") + chalk.bold.hex(palette.red)(label),
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: (text: string) => chalk.hex(palette.cyan)(text),
	selectedText: (text: string) => chalk.bold(text),
	description: (text: string) => chalk.dim(text),
	scrollInfo: (text: string) => chalk.dim(text),
	noMatch: (text: string) => chalk.dim(text),
};

export const markdownTheme: MarkdownTheme = {
	heading: (text: string) => chalk.bold.hex(palette.cyan)(text),
	link: (text: string) => chalk.hex(palette.accent)(text),
	linkUrl: (text: string) => chalk.dim(text),
	code: (text: string) => chalk.hex(palette.yellow)(text),
	codeBlock: (text: string) => chalk.hex(palette.leafBright)(text),
	codeBlockBorder: (text: string) => chalk.hex(palette.subtle)(text),
	quote: (text: string) => chalk.italic.hex(palette.muted)(text),
	quoteBorder: (text: string) => chalk.hex(palette.subtle)(text),
	hr: (text: string) => chalk.hex(palette.subtle)(text),
	listBullet: (text: string) => chalk.hex(palette.cyan)(text),
	bold: (text: string) => chalk.bold(text),
	italic: (text: string) => chalk.italic(text),
	strikethrough: (text: string) => chalk.strikethrough(text),
	underline: (text: string) => chalk.underline(text),
};

export const editorTheme: EditorTheme = {
	borderColor: (text: string) => chalk.hex(palette.subtle)(text),
	selectList: selectListTheme,
};
