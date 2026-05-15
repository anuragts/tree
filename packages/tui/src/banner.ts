import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { chalk, palette } from "./theme.js";

const VERSION = "0.1";

const FOLIAGE: Array<{ text: string; color: string }> = [
	{ text: "⢀⡀", color: "#bbf7d0" },
	{ text: "⢀⣶⣶⡀", color: "#86efac" },
	{ text: "⢀⣶⣿⣿⣶⡀", color: "#6ee7b7" },
	{ text: "⢀⣾⣿⣿⣿⣿⣷⡀", color: "#4ade80" },
	{ text: "⢰⣿⣿⣿⣿⣿⣿⣿⣿⡆", color: "#34d399" },
	{ text: "⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣆", color: "#22c55e" },
	{ text: "⠘⢿⣿⣿⣿⣿⣿⣿⣿⠃", color: "#16a34a" },
	{ text: "⠈⠛⠿⣿⣿⠿⠛⠁", color: "#15803d" },
];

const TRUNK: Array<{ text: string; color: string }> = [
	{ text: "┃┃", color: "#b45309" },
	{ text: "┃┃", color: "#92400e" },
	{ text: "┃┃", color: "#78350f" },
];

const GROUND = { text: "▁▂▄▆▇▇▆▄▂▁", color: "#52525b" };

const TAGLINES = ["grow conversations · branch ideas · resume any leaf"];

const HINT_COMMANDS = ["/help", "/new", "/sessions", "/tree", "/agents"];

export function runtimeLabel(adapterId: string): string {
	if (adapterId === "agno") return "agno";
	if (adapterId === "claude") return "claude code";
	if (adapterId === "codex") return "codex";
	return adapterId;
}

export class WelcomeBanner implements Component {
	private readonly blockWidth: number;

	constructor(private readonly getAdapterId: () => string) {
		this.blockWidth = Math.max(
			...FOLIAGE.map((row) => visibleWidth(row.text)),
			...TRUNK.map((row) => visibleWidth(row.text)),
			visibleWidth(GROUND.text),
		);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const blockLines: string[] = [];

		for (const { text, color } of FOLIAGE) {
			blockLines.push(
				this.centerInBlock(chalk.hex(color)(text), visibleWidth(text)),
			);
		}
		for (const { text, color } of TRUNK) {
			blockLines.push(
				this.centerInBlock(chalk.hex(color)(text), visibleWidth(text)),
			);
		}
		blockLines.push(
			this.centerInBlock(
				chalk.hex(GROUND.color)(GROUND.text),
				visibleWidth(GROUND.text),
			),
		);

		const adapter = runtimeLabel(this.getAdapterId());
		const wordmark =
			chalk.bold.hex(palette.leaf)("tree") +
			chalk.hex(palette.muted)(`  v${VERSION}`) +
			chalk.hex(palette.subtle)("  ·  ") +
			chalk.hex(palette.accent)(adapter);
		const tagline = chalk.hex(palette.muted)(TAGLINES[0]);
		const hints = HINT_COMMANDS.map((cmd) => chalk.hex(palette.cyan)(cmd)).join(
			chalk.hex(palette.subtle)("  ·  "),
		);

		for (const block of blockLines)
			lines.push(this.centerOnTerminal(block, width));
		lines.push("");
		lines.push(this.centerOnTerminal(wordmark, width));
		lines.push(this.centerOnTerminal(tagline, width));
		lines.push("");
		lines.push(this.centerOnTerminal(hints, width));
		return lines;
	}

	private centerInBlock(coloredText: string, naturalWidth: number): string {
		const pad = Math.max(0, Math.floor((this.blockWidth - naturalWidth) / 2));
		return " ".repeat(pad) + coloredText;
	}

	private centerOnTerminal(line: string, width: number): string {
		const w = visibleWidth(line);
		if (w >= width) return line;
		return " ".repeat(Math.floor((width - w) / 2)) + line;
	}
}
