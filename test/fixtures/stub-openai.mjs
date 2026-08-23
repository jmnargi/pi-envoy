/**
 * stub-openai.mjs — OpenAI-compatible chat-completions stub used to validate the
 * pi-envoy extension against the real `pi` CLI without provider credentials.
 *
 * Reply logic:
 *   - History contains "Delegation Contract"  -> child pi process: text "OK".
 *   - History has a role:"tool" message       -> main session 2nd turn, reports the
 *                                                child's answer ("OK" / "(no OK found)").
 *   - Otherwise                               -> main session 1st turn: a
 *                                                subagent_spawn tool call (worker/wait/verify).
 *
 * Every request is appended as one JSON line to stub-requests.jsonl next to this
 * module. Streaming replies are assembled up front and delivered in a single
 * write/end (no real streaming).
 */
import * as http from "node:http";
import * as fs from "node:fs";

const PORT = Number(process.argv[2] ?? 8787);
const HOST = "127.0.0.1";
const LOG_URL = new URL("./stub-requests.jsonl", import.meta.url);

const MODEL = "stub-openai";
const TOOL_NAME = "subagent_spawn";
const TOOL_CALL_ID = "call_stub_subagent_spawn";
const USAGE = { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 };

/** The exact subagent_spawn arguments the main session emits on its first turn. */
const TOOL_ARGS = JSON.stringify({
	objective:
		"Reply with exactly the word OK and nothing else. Do not call any other tools. You may not use the bash tool.",
	wait: true,
	worktree: false,
	verify: 'test "$(printf ok)" = "ok"',
});

/**
 * Extract the text of one message. `content` may be a plain string or an array
 * of blocks; all text blocks (type "text" or "input_text") are concatenated.
 */
function textOf(m) {
	if (!m || typeof m !== "object") return "";
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : ""))
			.join(" ");
	}
	return "";
}

/** Decide what the stub replies, from the request's message history. */
function planReply(msgs) {
	const all = msgs.map(textOf).join("\n");
	if (all.includes("Delegation Contract")) {
		const sawTaskPrompt = /task subagent/i.test(all);
		const didRead = msgs.some(
			(m) => m.role === "tool" || (Array.isArray(m.content) && m.content.some((c) => c?.type === "toolResult")),
		);
		if (!didRead) {
			return {
				kind: "tool",
				tool_name: "read",
				tool_call_id: "call_child_read",
				tool_args: JSON.stringify({ path: "package.json" }),
			};
		}
		return { kind: "text", text: sawTaskPrompt ? "OK" : "MISSING_TASK_PROMPT" };
	}
	if (msgs.some((m) => m.role === "tool")) {
		const ok = all.includes("OK");
		return { kind: "text", text: "Subagent finished. Answer was: " + (ok ? "OK" : "(no OK found)") };
	}
	return { kind: "tool", tool_name: TOOL_NAME, tool_call_id: TOOL_CALL_ID, tool_args: TOOL_ARGS };
}

/** One SSE frame: `data: <json>` followed by a blank line. */
function sseFrame(created, id, delta, finishReason) {
	const payload = {
		id,
		object: "chat.completion.chunk",
		created,
		model: MODEL,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return "data: " + JSON.stringify(payload) + "\n\n";
}
function sendJson(res, code, obj) {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(obj));
}

function streamReply(res, plan) {
	const created = Math.floor(Date.now() / 1000);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	let s = "";
	if (plan.kind === "tool") {
		s += sseFrame(created, "c1", { role: "assistant", content: null }, null);
		s += sseFrame(created, "c2", { tool_calls: [{ index: 0, id: TOOL_CALL_ID, type: "function", function: { name: TOOL_NAME, arguments: TOOL_ARGS } }] }, null);
		s += sseFrame(created, "c3", {}, "tool_calls");
	} else {
		s += sseFrame(created, "c1", { role: "assistant", content: "" }, null);
		s += sseFrame(created, "c2", { content: plan.text }, null);
		s += sseFrame(created, "c3", {}, "stop");
	}
	s += "\ndata\n";
	res.end(s);
}

function jsonReply(res, plan) {
	const message =
		plan.kind === "tool"
			? { role: "assistant", content: null, tool_calls: [{ id: TOOL_CALL_ID, type: "function", function: { name: TOOL_NAME, arguments: TOOL_ARGS } }] }
			: { role: "assistant", content: plan.text };
	sendJson(res, 200, {
		id: "chatcmpl-stub",
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: MODEL,
		choices: [{ index: 0, message, finish_reason: plan.kind === "tool" ? "tool_calls" : "stop" }],
		usage: USAGE,
	});
}

function handleRequest(req, res) {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		let body;
		try {
			body = JSON.parse(raw || "{}");
		} catch (err) {
			sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
			return;
		}

		const msgs = Array.isArray(body.messages) ? body.messages : [];
		const logEntry = {
			ts: Date.now(),
			stream: body.stream === true,
			msgs: msgs.map((m) => ({ role: m?.role ?? "", content: textOf(m) })),
		};
		try {
			fs.appendFileSync(LOG_URL, `${JSON.stringify(logEntry)}\n`);
		} catch {
			// logging is best-effort; never take the stub down over a log failure
		}

		const plan = planReply(msgs);
		if (body.stream === true) {
			streamReply(res, plan);
		} else {
			jsonReply(res, plan);
		}
	});
}

const server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
	console.log(`Server listening on port ${PORT}`);
});
