import { createServer } from "node:http";
import assert from "node:assert/strict";
import { SharedServiceConnection } from "../packages/desktop/dist/main/shared-service.js";

const origin = process.env.SHARED_VERIFY_URL || "http://127.0.0.1:3013";
const registry = process.env.AGENTROAM_DISCOVERY_DIR || "/tmp/agentroam-shared-live/registry";
const client = new SharedServiceConnection("/tmp/agentroam-shared-live/verify-selection.json", registry);
await client.initialize();
const choices = await client.status();
const selected = choices.choices.find((choice) => choice.url === origin);
assert(selected, "The desktop must discover the server");
await client.select(selected.instanceId);
const desktop = async (path, method = "GET", body) => {
  const response = await client.json(path, method, body === undefined ? undefined : JSON.stringify(body));
  assert(response.status < 400, `Desktop request failed: ${response.status}`);
  return JSON.parse(response.body);
};
const web = async (path, method = "GET", body) => {
  const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  assert(response.ok, `Web request failed: ${response.status}`);
  return response.json();
};

const seenModels = [];
let releaseModel;
const modelGate = new Promise((resolve) => { releaseModel = resolve; });
const model = createServer(async (req, res) => {
  if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "shared-model-v2" }] })); return; }
  let text = ""; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); seenModels.push(body.model);
  if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "shared service verified" } }] })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  await modelGate;
  for (const content of ["shared ", "service ", "verified"]) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
try {
  const settings = await desktop("/api/settings");
  await desktop("/api/settings", "POST", { revision: settings.revision, profiles: [{ id: "smoke", name: "Shared smoke", provider: "openai", modelId: "shared-model-v2", apiKey: "smoke-only", baseUrl: `http://127.0.0.1:${model.address().port}/v1` }], activeProfileId: "smoke" });
  const shared = await web("/api/settings");
  assert.equal(shared.modelId, "shared-model-v2"); assert.notEqual(shared.apiKey, "smoke-only");
  const project = await desktop("/api/projects", "POST", { name: "Shared service smoke", path: process.cwd() });
  assert((await web("/api/projects")).some((p) => p.id === project.id));
  const session = await web("/api/sessions", "POST", { title: "跨端共享验证", projectId: project.id });
  assert((await desktop(`/api/sessions/${session.id}`)).id === session.id);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20_000);
  const stream = await fetch(`${origin}/api/agent/stream?sessionId=${session.id}`, { signal: abort.signal });
  const chunks = [];
  const reading = (async () => { for await (const chunk of stream.body) chunks.push(Buffer.from(chunk).toString()); })();
  await desktop("/api/agent/run", "POST", { sessionId: session.id, input: "Reply shared service verified. Do not use tools." });
  const queued = await web(`/api/sessions/${session.id}/goals`, "POST", { kind: "message", objective: "Second shared reply, no tools.", sourceMessageId: crypto.randomUUID() });
  assert(queued.state.queued.some((item) => item.objective === "Second shared reply, no tools."));
  assert((await desktop(`/api/sessions/${session.id}/goals`)).queued.length > 0);
  client.closeStreams();
  releaseModel();
  await reading; clearTimeout(timeout);
  let queueState;
  const deadline = Date.now() + 20_000;
  do {
    queueState = await web(`/api/sessions/${session.id}/goals`);
    if (!queueState.active && !queueState.queued.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert(!queueState.active && !queueState.queued.length, "Server must drain after client disconnect");
  const history = await web(`/api/sessions/${session.id}`);
  assert.equal(history.messages.filter((m) => m.role === "user").length, 2);
  assert.equal(history.status, "completed");
  assert(history.messages.some((m) => m.role === "assistant" && m.content === "shared service verified"));
  assert(chunks.join("").includes("text_chunk")); assert(chunks.join("").includes('"type":"done"'));
  assert(seenModels.length > 0 && seenModels.every((name) => name === "shared-model-v2"));
  client.closeStreams();
  assert.equal((await web(`/api/sessions/${session.id}`)).status, "completed");
  console.log(JSON.stringify({ passed: true, origin, projectId: project.id, sessionId: session.id, modelRequests: seenModels.length, checks: ["desktop discovery", "shared settings", "redacted credentials", "shared projects", "shared history", "desktop run to web SSE", "configured model used", "closing client preserves server", "shared durable queue drains without client"] }, null, 2));
} finally { releaseModel(); client.closeStreams(); model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); }
