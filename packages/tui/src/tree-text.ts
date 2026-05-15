import type { SessionTreeNode } from "@tree/core";
import { chalk, palette } from "./theme.js";

export function renderSessionTree(
	nodes: SessionTreeNode[],
	activeId: string | null,
): string {
	const lines: string[] = [];
	const visit = (
		node: SessionTreeNode,
		prefix: string,
		isLast: boolean,
		depth: number,
	): void => {
		const isActive = node.entry.id === activeId;
		const marker = isActive
			? chalk.bold.hex(palette.leaf)("●")
			: chalk.hex(palette.subtle)("○");
		const connector = prefix
			? chalk.hex(palette.subtle)(isLast ? "└─ " : "├─ ")
			: chalk.hex(palette.subtle)("● ");
		const body = label(node, isActive);
		lines.push(
			`${chalk.hex(palette.subtle)(prefix)}${connector}${marker} ${body}`,
		);
		const nextPrefix = prefix + (prefix ? (isLast ? "   " : "│  ") : "  ");
		node.children.forEach((child, index) => {
			visit(child, nextPrefix, index === node.children.length - 1, depth + 1);
		});
	};
	nodes.forEach((node, index) => {
		visit(node, "", index === nodes.length - 1, 0);
	});
	return lines.join("\n");
}

function label(node: SessionTreeNode, isActive: boolean): string {
	const entry = node.entry;
	if (entry.type === "message") {
		const role = roleLabel(entry.role);
		const content = entry.content.replace(/\s+/g, " ").slice(0, 72);
		const text = isActive
			? chalk.bold(content)
			: chalk.hex(palette.muted)(content);
		return `${role} ${text}`;
	}
	if (entry.type === "event")
		return chalk.hex(palette.subtle)(`event · ${entry.event.type}`);
	if (entry.type === "adapter_state")
		return chalk.hex(palette.subtle)(`adapter · ${entry.adapterId}`);
	return chalk.hex(palette.subtle)(entry.type);
}

function roleLabel(role: string): string {
	if (role === "user") return chalk.hex(palette.user)("you");
	if (role === "assistant") return chalk.hex(palette.assistant)("tree");
	return chalk.hex(palette.system)(role);
}
