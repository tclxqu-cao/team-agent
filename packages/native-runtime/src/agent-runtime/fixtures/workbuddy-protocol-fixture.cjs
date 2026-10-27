const { createInterface } = require("node:readline");
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const send = packet => process.stdout.write(JSON.stringify(packet) + "\n");
const sessions = join(process.env.CATALOG_ROOT, "projects", "fixture");
mkdirSync(sessions, { recursive: true });
let active;
let pending;
function append(role, content) {
  appendFileSync(join(sessions, active + ".jsonl"), JSON.stringify({ id: randomUUID(), type: "message", role, content: [{ type: "text", text: content }], sessionId: active, cwd: process.cwd(), timestamp: Date.now() }) + "\n");
}
function finish(text, messageFields = {}) {
  append("assistant", text);
  send({ type: "stream_event", session_id: active, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  send({ type: "assistant", session_id: active, message: { role: "assistant", content: [{ type: "text", text }], ...messageFields } });
  send({ type: "result", session_id: active, subtype: "success", is_error: false, result: text });
}
createInterface({ input: process.stdin }).on("line", line => {
  const packet = JSON.parse(line);
  if (packet.type === "control_request") {
    const request = packet.request;
    if (request.subtype === "initialize") send({ type: "control_response", response: { subtype: "success", request_id: packet.request_id, response: { models: [{ id: "native-workbuddy", name: "Native WorkBuddy" }], account: { token: "must-not-leak" } } } });
    else if (request.subtype === "interrupt") {
      send({ type: "control_response", response: { subtype: "success", request_id: packet.request_id, response: {} } });
      send({ type: "result", session_id: active, subtype: "success", terminal_reason: "aborted_streaming" });
    }
  } else if (packet.type === "control_response" && pending) {
    const allowed = packet.response.response.behavior === "allow";
    pending = null;
    finish(allowed ? "ALLOWED" : "DENIED");
  } else if (packet.type === "user") {
    active = packet.session_id;
    const path = join(sessions, active + ".jsonl");
    if (args.includes("--resume") && (!existsSync(path) || flag("--resume") !== active)) throw new Error("Resume did not use the native identity");
    if (!args.includes("--resume") && flag("--session-id") !== active) throw new Error("Missing native session ID");
    const text = packet.message.content[0].text;
    const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
    append("user", text);
    if (text === "CRASH") process.exit(9);
    else if (text === "NATIVE_AUTH_REQUIRED" || text === "NATIVE_AUTH_FAILED" || text === "QUOTE_AUTH_NOTICE" || text === "UNKNOWN_MODEL_QUOTE") {
      const notice = `Authentication ${text === "NATIVE_AUTH_FAILED" ? "failed" : "required"}. Please use /login command to sign in to your account`;
      finish(notice, { model: text === "QUOTE_AUTH_NOTICE" ? "native-workbuddy" : "unknown", stop_reason: null, usage: { input_tokens: text === "UNKNOWN_MODEL_QUOTE" ? 10 : 0, output_tokens: text === "UNKNOWN_MODEL_QUOTE" ? 12 : 0 } });
    } else if (text === "CANCEL") send({ type: "stream_event", session_id: active, event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } });
    else if (text === "PERMISSION") {
      pending = packet;
      send({ type: "control_request", request_id: "native-permission", request: { subtype: "can_use_tool", tool_name: "WriteFile", input: { path: "/not-written", questions: [{ question: "Do not misclassify arbitrary tools as questions" }] } } });
    } else if (text === "RECALL") finish(previous.match(/REMEMBER ([A-Z0-9_]+)/)?.[1] || "MISSING_CONTEXT");
    else finish(text.startsWith("REMEMBER ") ? "READY" : "native answer");
  }
});
