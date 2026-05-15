export interface SseMessage {
	event?: string;
	id?: string;
	data: string;
	json?: unknown;
}

export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<SseMessage> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let match = buffer.match(/\r?\n\r?\n/);
			while (match !== null && match.index !== undefined) {
				const index = match.index;
				const raw = buffer.slice(0, index);
				buffer = buffer.slice(index + match[0].length);
				const message = parseSseMessage(raw);
				if (message) yield message;
				match = buffer.match(/\r?\n\r?\n/);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) {
			const message = parseSseMessage(buffer);
			if (message) yield message;
		}
	} finally {
		reader.releaseLock();
	}
}

export function parseSseMessage(raw: string): SseMessage | null {
	let event: string | undefined;
	let id: string | undefined;
	const data: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "id") id = value;
		else if (field === "data") data.push(value);
	}
	if (!event && !id && data.length === 0) return null;
	const text = data.join("\n");
	let json: unknown;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = undefined;
	}
	return { event, id, data: text, json };
}
