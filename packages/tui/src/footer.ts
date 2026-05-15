import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AdapterSession, TreeConfig } from "@tree/core";
import { runtimeLabel } from "./banner.js";
import { chalk, palette } from "./theme.js";

export interface FooterState {
	config: TreeConfig;
	activeAdapter: string;
	sessionId?: string;
	adapterSession?: AdapterSession;
	working: boolean;
	runId?: string;
	messageCount: number;
	runtimeKind: string;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Footer implements Component {
	private spinnerIndex = 0;
	private spinnerTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly getState: () => FooterState,
		private readonly onTick?: () => void,
	) {}

	startSpinner(): void {
		if (this.spinnerTimer) return;
		this.spinnerTimer = setInterval(() => {
			this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
			this.onTick?.();
		}, 80);
	}

	stopSpinner(): void {
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.getState();
		const cwd = state.config.cwd.replace(process.env.HOME ?? "", "~");
		const sep = chalk.hex(palette.subtle)(" │ ");

		const adapterSeg =
			chalk.hex(palette.leaf)("●") +
			" " +
			chalk.bold(runtimeLabel(state.activeAdapter));
		const cwdSeg = chalk.hex(palette.muted)(cwd);
		const sessionSeg = state.sessionId
			? chalk.hex(palette.accent)("⌥ ") +
				chalk.hex(palette.muted)(state.sessionId.slice(0, 8))
			: "";
		const msgSeg =
			state.messageCount > 0
				? chalk.hex(palette.cyan)("✉ ") +
					chalk.hex(palette.muted)(String(state.messageCount))
				: "";

		const left = [adapterSeg, cwdSeg, sessionSeg, msgSeg]
			.filter(Boolean)
			.join(sep);

		const rightParts: string[] = [];
		if (state.working) {
			const frame = SPINNER_FRAMES[this.spinnerIndex];
			rightParts.push(
				chalk.hex(palette.yellow)(frame) +
					" " +
					chalk.hex(palette.yellow)("working"),
			);
		} else {
			rightParts.push(chalk.hex(palette.leaf)("idle"));
		}
		if (state.runId) {
			rightParts.push(
				chalk.hex(palette.muted)(`run ${state.runId.slice(0, 8)}`),
			);
		}
		const right = rightParts.join(sep);

		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		const gap = Math.max(1, width - leftWidth - rightWidth);
		const line = `${left}${" ".repeat(gap)}${right}`;
		return [truncateToWidth(line, width, chalk.hex(palette.subtle)("..."))];
	}
}
