import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiHubTransport } from "../../../ai-hub/transport.js";
import type { Message, StreamEvent, ToolDefinition } from "../../entities.js";
import {
  AiHubProvider,
  composeAiHubTranscript,
  extractReplyAfterAnchor,
  extractReplyAfterBaseline,
  parseAiHubToolCall,
  selectAiHubRelayMessages,
  stripCapturedCodeToolbar,
} from "../AiHubProvider.js";

const tools: ToolDefinition[] = [{
  name: "read_file",
  description: "读取文件",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
}];

const bashTools: ToolDefinition[] = [{
  name: "bash",
  description: "执行 shell 命令",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number" },
    },
    required: ["command"],
  },
}];

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AiHubProvider", () => {
  it("removes webpage code-block toolbar labels from captured replies", () => {
    expect(stripCapturedCodeToolbar("当前目录是：\n\ntext\n复制\n下载\n/Users/demo")).toBe(
      "当前目录是：\n\n/Users/demo",
    );
    expect(stripCapturedCodeToolbar("回答：\n\ntext\n\n复制\n\n下载\n\n```\nline-1\nline-2\n```")).toBe(
      "回答：\n\n```\nline-1\nline-2\n```",
    );
    expect(stripCapturedCodeToolbar("Copy is ordinary prose")).toBe("Copy is ordinary prose");
  });

  it("composes the system context, conversation history and latest user message", () => {
    const messages: Message[] = [
      { role: "system", content: "只回答事实" },
      { role: "user", content: "上一问" },
      { role: "assistant", content: "上一答" },
      { role: "user", content: "最新问题" },
    ];

    const transcript = composeAiHubTranscript(messages, "anchor-1");

    expect(transcript).toContain("【Agent 转发 · anchor-1】");
    expect(transcript).toContain("【系统设定】\n只回答事实");
    expect(transcript).toContain("用户：上一问");
    expect(transcript).toContain("助手：上一答");
    expect(transcript).toContain("【用户最新消息】\n最新问题");
  });

  it("includes tool schemas and prior tool calls/results in the transcript", () => {
    const transcript = composeAiHubTranscript([
      { role: "user", content: "读取版本" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "package.json" } }] },
      { role: "tool", content: '{"version":"1.0.0"}', name: "read_file", toolCallId: "call-1" },
    ], "anchor-tools", tools);

    expect(transcript).toContain('"name": "read_file"');
    expect(transcript).toContain('"required": [');
    expect(transcript).toContain("助手调用工具（call_id=call-1）：read_file");
    expect(transcript).toContain("工具结果（name=read_file, call_id=call-1");
    expect(transcript).toContain("每次只能调用一个工具");
    expect(transcript).toContain("不要重复调用同一个工具");
  });

  it("strictly specifies JSON escaping and raw URLs on initial and reminder turns", () => {
    const initial = composeAiHubTranscript(
      [{ role: "user", content: "调用接口" }],
      "anchor-strict-initial",
      bashTools,
    );
    const reminder = composeAiHubTranscript(
      [{ role: "user", content: "重试" }],
      "anchor-strict-reminder",
      bashTools,
      "/Users/demo/project",
      false,
    );

    for (const transcript of [initial, reminder]) {
      expect(transcript).toContain("整段输出必须能被 JSON.parse 直接解析");
      expect(transcript).toContain(String.raw`双引号写成 \"`);
      expect(transcript).toContain(String.raw`反斜杠写成 \\`);
      expect(transcript).toContain(String.raw`换行写成 \n`);
      expect(transcript).toContain("URL 必须保持原始文本");
      expect(transcript).toContain("[url](url)");
      expect(transcript).toContain(String.raw`-d '{\"Serialid\":\"ABC\"}'`);
      const example = transcript.match(/bash 命令中嵌套 JSON 的正确示例：(\{[^\n]+\})/)?.[1];
      expect(example).toBeTruthy();
      expect(() => JSON.parse(example!)).not.toThrow();
    }
  });

  it("marks failed tool results and instructs the webpage model to repair them", () => {
    const transcript = composeAiHubTranscript([
      { role: "user", content: "查看打包日志" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-9", name: "read_file", arguments: { path: "pack.log" } }] },
      { role: "tool", content: "/bin/sh: tail: command not found", name: "read_file", toolCallId: "call-9", isError: true },
    ], "anchor-failed", tools);

    expect(transcript).toContain("工具结果（name=read_file, call_id=call-9, 状态=失败）");
    expect(transcript).toContain("【工具执行失败】");
    expect(transcript).toContain("修正调用参数或改用其他工具");
  });

  it("labels successful tool results without the repair instruction", () => {
    const transcript = composeAiHubTranscript([
      { role: "user", content: "读取版本" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "package.json" } }] },
      { role: "tool", content: '{"version":"1.0.0"}', name: "read_file", toolCallId: "call-1" },
    ], "anchor-ok", tools);

    expect(transcript).toContain("工具结果（name=read_file, call_id=call-1, 状态=成功）");
    expect(transcript).not.toContain("【工具执行失败】");
  });

  it("reminds later turns of current Agent tools without serializing schemas again", () => {
    const transcript = composeAiHubTranscript(
      [{ role: "user", content: "继续" }],
      "anchor-reuse",
      tools,
      "/Users/demo/project",
      false,
    );

    expect(transcript).not.toContain('"name": "read_file"');
    expect(transcript).not.toContain('"required": [');
    expect(transcript).toContain("【本轮 Agent 工具提醒】");
    expect(transcript).toContain("当前仍可调用的 Agent 工具名称：read_file");
    expect(transcript).toContain("回看并沿用前文协议");
    expect(transcript).toContain("网页站点自身的 search、open、find、image_search 等内置工具不是 Agent 工具");
    expect(transcript).toContain("不要把计划执行工具的思考当成最终回答");
  });

  it("sends full context only when bootstrapping an empty webpage conversation", () => {
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
    ];

    expect(selectAiHubRelayMessages(messages, false)).toEqual(messages);
    expect(selectAiHubRelayMessages(messages, true)).toEqual([
      { role: "user", content: "new question" },
    ]);
    expect(selectAiHubRelayMessages([
      ...messages,
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: {} }] },
      { role: "tool", content: "result", name: "read_file", toolCallId: "call-1" },
    ], true, messages.length)).toEqual([
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: {} }] },
      { role: "tool", content: "result", name: "read_file", toolCallId: "call-1" },
    ]);
  });

  it("never truncates the project directory, tool definitions, or latest message", () => {
    const longHistory = "旧历史".repeat(40_000);
    const transcript = composeAiHubTranscript([
      { role: "user", content: longHistory },
      { role: "assistant", content: longHistory },
      { role: "user", content: "必须保留的最新问题" },
    ], "anchor-required", tools, "/Users/demo/current-project");

    expect(transcript.length).toBeLessThanOrEqual(100_000);
    expect(transcript).toContain("【当前项目目录】\n/Users/demo/current-project");
    expect(transcript).toContain('"name": "read_file"');
    expect(transcript).toContain('"description": "读取文件"');
    expect(transcript).toContain("【用户最新消息】\n必须保留的最新问题");
    expect(transcript).toContain("【历史上下文已按 CA 规则压缩】");
    expect(transcript).not.toContain("中间内容过长已截断");
  });

  it("parses direct and fenced tool-call envelopes", () => {
    expect(parseAiHubToolCall(
      '{"type":"tool_call","id":"call-2","name":"read_file","arguments":{"path":"README.md"}}',
      tools,
    )).toEqual({ id: "call-2", name: "read_file", arguments: { path: "README.md" } });
    expect(parseAiHubToolCall(
      '```json\n{"type":"tool_call","name":"read_file","arguments":{"path":"README.md"}}\n```',
      tools,
    )).toMatchObject({ id: expect.stringMatching(/^call_aihub_/), name: "read_file" });
  });

  it("parses DeepSeek DSML tool calls without changing the command body", () => {
    const command = "ls -t outputs/ | head -30; echo '---MANIFESTS---'; find outputs -maxdepth 2 -name 'manifest' -newermt '2026-09-10' 2>/dev/null | head -20; echo '---RECENT---'; ls -t outputs/republish-3000-20260915-105830/ 2>/dev/null | head; ls -t outputs/full-release-20260914/ 2>/dev/null | head";
    const reply = `<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">${command}\\</｜｜DSML｜｜ parameter>\n\\</｜｜DSML｜｜ invoke>\n\\</｜｜DSML｜｜ calls>`;

    expect(parseAiHubToolCall(reply, bashTools)).toEqual({
      id: expect.stringMatching(/^call_aihub_/),
      name: "bash",
      arguments: { command },
    });
  });

  it("parses DSML after prose, supports multiple parameters and normal closing tags", () => {
    const reply = `先读取文件。\n<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_file"><｜｜DSML｜｜ parameter name="path" string="true">docs/a &amp; b.md</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="line">3</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;

    expect(parseAiHubToolCall(reply, tools)).toMatchObject({
      name: "read_file",
      arguments: { path: "docs/a & b.md", line: 3 },
    });
  });

  it("rejects malformed, duplicate and multiple-invoke DSML tool calls", () => {
    const malformed = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_file"><｜｜DSML｜｜ parameter name="path" string="true">README.md</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;
    const duplicate = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_file"><｜｜DSML｜｜ parameter name="path">a</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="path">b</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;
    const multiple = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_file"><｜｜DSML｜｜ parameter name="path">a</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke><｜｜DSML｜｜ invoke name="read_file"><｜｜DSML｜｜ parameter name="path">b</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;

    for (const reply of [malformed, duplicate, multiple]) {
      expect(() => parseAiHubToolCall(reply, tools)).toThrow("DSML 工具调用格式无效");
    }
  });

  it("applies existing registered-tool validation to DSML calls", () => {
    const reply = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="unknown"><｜｜DSML｜｜ parameter name="value">1</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;

    expect(() => parseAiHubToolCall(reply, tools)).toThrow("未注册");
    expect(parseAiHubToolCall("普通文本里提到 DSML，但没有标签", tools)).toBeNull();
  });

  it("extracts a complete tool-call envelope from mixed webpage reasoning", () => {
    const reply = [
      "先检查文件。",
      '{"type":"tool_call","id":"call-mixed","name":"read_file","arguments":{"path":"docs/{name}.md"}}',
      "工具执行后再继续。",
      '{"type":"tool_call","id":"call-later","name":"read_file","arguments":{"path":"later.md"}}',
    ].join("\n");

    expect(parseAiHubToolCall(reply, tools)).toEqual({
      id: "call-mixed",
      name: "read_file",
      arguments: { path: "docs/{name}.md" },
    });
  });

  it("repairs unescaped quotes inside a single-line tool argument", () => {
    const reply = [
      "继续检查。",
      '{"type":"tool_call","id":"call-shell","name":"read_file","arguments":{"path":"docs/"quoted".md"}}',
    ].join("\n");

    expect(parseAiHubToolCall(reply, tools)).toEqual({
      id: "call-shell",
      name: "read_file",
      arguments: { path: 'docs/"quoted".md' },
    });
  });

  it("does not treat a colon inside an unescaped command quote as the value boundary", () => {
    const reply = '{"type":"tool_call","id":"call-grep","name":"read_file","arguments":{"path":"grep -E \"release[^\"]*\":\" package.json"}}';

    expect(parseAiHubToolCall(reply, tools)).toEqual({
      id: "call-grep",
      name: "read_file",
      arguments: { path: 'grep -E "release[^"]*":" package.json' },
    });
  });

  it("repairs shell backreferences that are invalid JSON escapes", () => {
    const reply = String.raw`{"type":"tool_call","id":"call-sed","name":"read_file","arguments":{"path":"sed -E 's#(://[^:]+:)[^@]+@#\1**@#g' ~/.git-credentials"}}`;

    expect(parseAiHubToolCall(reply, tools)).toEqual({
      id: "call-sed",
      name: "read_file",
      arguments: { path: String.raw`sed -E 's#(://[^:]+:)[^@]+@#\1**@#g' ~/.git-credentials` },
    });
  });

  it("preserves legal JSON escapes while repairing shell syntax", () => {
    const reply = String.raw`{"type":"tool_call","id":"call-shell","name":"read_file","arguments":{"path":"printf 'line\n'; echo \(ok\)"}}`;

    expect(parseAiHubToolCall(reply, tools)).toEqual({
      id: "call-shell",
      name: "read_file",
      arguments: { path: "printf 'line\n'; echo \\(ok\\)" },
    });
  });

  it("repairs the multiline token verification call rendered by DeepSeek", () => {
    const tokenLength = '${#TOKEN}';
    const reply = String.raw`{"type":"tool_call","id":"call-token","name":"read_file","arguments":{"path":"TOKEN=$(security find-generic-password -s com.agentroam.npm-token -a npmjs-publisher -w 2>/dev/null);
if [ -z "$TOKEN" ]; then echo 'TOKEN_EMPTY'; else echo "TOKEN_LEN=${tokenLength}"; npm whoami --registry=https://registry.npmjs.org/ --//registry.npmjs.org/:_authToken="$TOKEN" 2>&1 | tail -3; fi"}}`;

    expect(parseAiHubToolCall(reply, tools)).toEqual({
      id: "call-token",
      name: "read_file",
      arguments: {
        path: "TOKEN=$(security find-generic-password -s com.agentroam.npm-token -a npmjs-publisher -w 2>/dev/null);\nif [ -z \"$TOKEN\" ]; then echo 'TOKEN_EMPTY'; else echo \"TOKEN_LEN=${#TOKEN}\"; npm whoami --registry=https://registry.npmjs.org/ --//registry.npmjs.org/:_authToken=\"$TOKEN\" 2>&1 | tail -3; fi",
      },
    });
  });

  it("repairs the captured curl tool call with a single-quoted JSON body", () => {
    const reply = String.raw`{"type":"tool_call","id":"call_curl_query1","name":"bash","arguments":{"command":"curl -s -X POST 'http://finance.fly.17usoft.com/clear/api/PaymentOrder/QueryListBySerialId' -H 'Content-Type: application/json' -d '{"Serialid":"OHR3D5ARJ1062P006513"}'","timeout":30000}}`;

    expect(parseAiHubToolCall(reply, bashTools)).toEqual({
      id: "call_curl_query1",
      name: "bash",
      arguments: {
        command: "curl -s -X POST 'http://finance.fly.17usoft.com/clear/api/PaymentOrder/QueryListBySerialId' -H 'Content-Type: application/json' -d '{\"Serialid\":\"OHR3D5ARJ1062P006513\"}'",
        timeout: 30000,
      },
    });
  });

  it("repairs the latest captured curl call with JSON data and write-out newlines", () => {
    const reply = String.raw`{"type":"tool_call","id":"call_curl_payquery1","name":"bash","arguments":{"command":"curl -sS -X POST 'http://finance.fly.17usoft.com/clear/api/PaymentOrder/QueryListBySerialId' -H 'Content-Type: application/json' -d '{"Serialid":"OHR3D5ARJ1062P006513"}' -w '\n---HTTP_CODE:%{http_code}---\n' --max-time 30","timeout":40000}}`;

    expect(parseAiHubToolCall(reply, bashTools)).toEqual({
      id: "call_curl_payquery1",
      name: "bash",
      arguments: {
        command: "curl -sS -X POST 'http://finance.fly.17usoft.com/clear/api/PaymentOrder/QueryListBySerialId' -H 'Content-Type: application/json' -d '{\"Serialid\":\"OHR3D5ARJ1062P006513\"}' -w '\n---HTTP_CODE:%{http_code}---\n' --max-time 30",
        timeout: 40000,
      },
    });
  });

  it("repairs a shell JSON body containing multiple comma-separated fields", () => {
    const reply = String.raw`{"type":"tool_call","id":"call-curl-multi","name":"bash","arguments":{"command":"curl http://example.invalid -d '{"Serialid":"ABC","Status":"READY","Items":[{"id":1},{"id":2}]}'","timeout":40000}}`;

    expect(parseAiHubToolCall(reply, bashTools)).toEqual({
      id: "call-curl-multi",
      name: "bash",
      arguments: {
        command: `curl http://example.invalid -d '{"Serialid":"ABC","Status":"READY","Items":[{"id":1},{"id":2}]}'`,
        timeout: 40000,
      },
    });
  });

  it("accepts stringified arguments after validating they decode to an object", () => {
    const reply = String.raw`{"type":"tool_call","id":"call-stringified","name":"bash","arguments":"{\"command\":\"printf ok\",\"timeout\":1000}"}`;

    expect(parseAiHubToolCall(reply, bashTools)).toEqual({
      id: "call-stringified",
      name: "bash",
      arguments: { command: "printf ok", timeout: 1000 },
    });
  });

  it("repairs trailing commas outside JSON strings", () => {
    const reply = '{"type":"tool_call","id":"call-trailing","name":"read_file","arguments":{"path":"README.md",},}';

    expect(parseAiHubToolCall(reply, tools)).toEqual({
      id: "call-trailing",
      name: "read_file",
      arguments: { path: "README.md" },
    });
  });

  it("restores legacy Markdown auto-links only inside bash command arguments", () => {
    const reply = '{"type":"tool_call","id":"call-link","name":"bash","arguments":{"command":"curl [http://example.invalid/path](http://example.invalid/path)"}}';

    expect(parseAiHubToolCall(reply, bashTools)).toEqual({
      id: "call-link",
      name: "bash",
      arguments: { command: "curl http://example.invalid/path" },
    });
  });

  it("rejects unknown tools and invalid arguments", () => {
    expect(() => parseAiHubToolCall(
      '{"type":"tool_call","name":"delete_everything","arguments":{}}',
      tools,
    )).toThrow("未注册");
    expect(() => parseAiHubToolCall(
      '{"type":"tool_call","name":"read_file","arguments":"README.md"}',
      tools,
    )).toThrow("arguments 必须是 JSON 对象");
    expect(() => parseAiHubToolCall(
      '{"type":"tool_call","name":"read_file","arguments":{',
      tools,
    )).toThrow("JSON 格式无效");
  });

  it("extracts only the assistant reply after the latest matching anchor", () => {
    expect(extractReplyAfterAnchor([
      { role: "assistant", text: "旧回复" },
      { role: "user", text: "prefix anchor-2 suffix" },
      { role: "assistant", text: "本轮回复" },
    ], "anchor-2")).toBe("本轮回复");
  });

  it("falls back to an assistant reply added after the pre-send baseline", () => {
    expect(extractReplyAfterBaseline([
      { role: "assistant", text: "旧回复" },
      { role: "assistant", text: "新增回复" },
    ], ["旧回复"])).toBe("新增回复");
    expect(extractReplyAfterBaseline([
      { role: "assistant", text: "旧回复" },
    ], ["旧回复"])).toBe("");
  });

  it("reports desktop offline before attempting a broadcast", async () => {
    const transport: AiHubTransport = {
      status: vi.fn().mockResolvedValue({ available: false }),
      broadcast: vi.fn(),
      capture: vi.fn(),
      continueGeneration: vi.fn(),
    };
    const provider = new AiHubProvider({ apiKey: "", modelId: "deepseek", transport });

    const events = await collect(provider.streamChat([{ role: "user", content: "你好" }]));

    expect(events).toEqual([{
      type: "error",
      code: "desktop_offline",
      message: expect.stringContaining("桌面端离线"),
    }]);
    expect(transport.broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts through the selected site and returns a stable captured reply", async () => {
    vi.useFakeTimers();
    const transport: AiHubTransport = {
      status: vi.fn().mockResolvedValue({ available: true }),
      broadcast: vi.fn().mockResolvedValue({
        available: true,
        results: [{ siteId: "deepseek", ok: true }],
      }),
      capture: vi.fn().mockImplementation(async () => {
        if (vi.mocked(transport.broadcast).mock.calls.length === 0) {
          return { available: true, results: [{ siteId: "deepseek", ok: true, messages: [] }] };
        }
        const transcript = vi.mocked(transport.broadcast).mock.calls[0][0];
        return {
          available: true,
          results: [{
            siteId: "deepseek",
            ok: true,
            messages: [
              { role: "user", text: transcript },
              { role: "assistant", text: "来自 DeepSeek 网页的回复" },
            ],
          }],
        };
      }),
      continueGeneration: vi.fn(),
    };
    const provider = new AiHubProvider({ apiKey: "", modelId: "deepseek", transport });
    const pending = collect(provider.streamChat(
      [{ role: "user", content: "请回答" }],
      { sessionId: "session-one", workingDirectory: "/Users/demo/project" },
    ));

    await vi.advanceTimersByTimeAsync(8_100);
    const events = await pending;

    expect(transport.broadcast).toHaveBeenCalledWith(
      expect.stringContaining("【当前项目目录】\n/Users/demo/project"),
      ["deepseek"],
      [],
      "session-one",
    );
    expect(transport.capture).toHaveBeenCalledWith(["deepseek"], "session-one");
    expect(events).toEqual([
      { type: "text_chunk", text: "来自 DeepSeek 网页的回复" },
      { type: "text_done" },
    ]);
  });

  it("broadcasts the latest transient tool observation images", async () => {
    vi.useFakeTimers();
    const transport: AiHubTransport = {
      status: vi.fn().mockResolvedValue({ available: true }),
      broadcast: vi.fn().mockResolvedValue({
        available: true,
        results: [{ siteId: "deepseek", ok: true }],
      }),
      capture: vi.fn().mockImplementation(async () => {
        if (vi.mocked(transport.broadcast).mock.calls.length === 0) {
          return { available: true, results: [{ siteId: "deepseek", ok: true, messages: [] }] };
        }
        return {
          available: true,
          results: [{ siteId: "deepseek", ok: true, messages: [{ role: "assistant", text: "看到了" }] }],
        };
      }),
      continueGeneration: vi.fn(),
    };
    const provider = new AiHubProvider({ apiKey: "", modelId: "deepseek", transport });
    const pending = collect(provider.streamChat([
      { role: "user", content: "旧问题", images: ["data:image/png;base64,b2xk"] },
      { role: "tool", content: "captured", toolCallId: "call-1", name: "computer" },
      { role: "user", name: "__tool_observation__", content: "Visual observations from tool calls: call-1", images: ["data:image/jpeg;base64,bmV3"] },
    ], { sessionId: "visual-tool" }));

    await vi.advanceTimersByTimeAsync(8_100);
    await pending;

    expect(transport.broadcast).toHaveBeenCalledWith(
      expect.any(String),
      ["deepseek"],
      ["data:image/jpeg;base64,bmV3"],
      "visual-tool",
    );
  });

  it("emits a standard tool call without text events", async () => {
    vi.useFakeTimers();
    const toolReply = '{"type":"tool_call","id":"call-3","name":"read_file","arguments":{"path":"README.md"}}';
    const transport: AiHubTransport = {
      status: vi.fn().mockResolvedValue({ available: true }),
      broadcast: vi.fn().mockResolvedValue({
        available: true,
        results: [{ siteId: "deepseek", ok: true }],
      }),
      capture: vi.fn().mockImplementation(async () => {
        if (vi.mocked(transport.broadcast).mock.calls.length === 0) {
          return { available: true, results: [{ siteId: "deepseek", ok: true, messages: [] }] };
        }
        const transcript = vi.mocked(transport.broadcast).mock.calls[0][0];
        return { available: true, results: [{ siteId: "deepseek", ok: true, messages: [
          { role: "user", text: transcript },
          { role: "assistant", text: toolReply },
        ] }] };
      }),
      continueGeneration: vi.fn(),
    };
    const provider = new AiHubProvider({ apiKey: "", modelId: "deepseek", transport });
    const pending = collect(provider.streamChat([{ role: "user", content: "读取 README" }], { tools }));

    await vi.advanceTimersByTimeAsync(8_100);

    expect(await pending).toEqual([{
      type: "tool_call",
      toolCall: { id: "call-3", name: "read_file", arguments: { path: "README.md" } },
    }]);
    expect(vi.mocked(transport.broadcast).mock.calls[0][0]).toContain('"name": "read_file"');
  });

  it("waits for webpage generation to finish before accepting a stable tool call", async () => {
    vi.useFakeTimers();
    const reasoning = "我应该先调用工具。";
    const toolReply = '{"type":"tool_call","id":"call-late","name":"read_file","arguments":{"path":"README.md"}}';
    let postSendCaptures = 0;
    const transport: AiHubTransport = {
      status: vi.fn().mockResolvedValue({ available: true }),
      broadcast: vi.fn().mockResolvedValue({ available: true, results: [{ siteId: "deepseek", ok: true }] }),
      capture: vi.fn().mockImplementation(async () => {
        if (vi.mocked(transport.broadcast).mock.calls.length === 0) {
          return { available: true, results: [{ siteId: "deepseek", ok: true, messages: [] }] };
        }
        postSendCaptures += 1;
        const transcript = vi.mocked(transport.broadcast).mock.calls[0][0];
        const stillGenerating = postSendCaptures <= 4;
        return { available: true, results: [{
          siteId: "deepseek",
          ok: true,
          generating: stillGenerating,
          messages: [
            { role: "user", text: transcript },
            { role: "assistant", text: stillGenerating ? reasoning : toolReply },
          ],
        }] };
      }),
      continueGeneration: vi.fn(),
    };
    const provider = new AiHubProvider({ apiKey: "", modelId: "deepseek", transport });
    const pending = collect(provider.streamChat([{ role: "user", content: "读取 README" }], { tools }));

    await vi.advanceTimersByTimeAsync(12_100);

    expect(await pending).toEqual([{
      type: "tool_call",
      toolCall: { id: "call-late", name: "read_file", arguments: { path: "README.md" } },
    }]);
    expect(postSendCaptures).toBeGreaterThan(4);
  });

  it("returns an error instead of stable partial text when the page is still generating at timeout", async () => {
    vi.useFakeTimers();
    const reasoning = "我应该先调用工具。";
    const transport: AiHubTransport = {
      status: vi.fn().mockResolvedValue({ available: true }),
      broadcast: vi.fn().mockResolvedValue({ available: true, results: [{ siteId: "deepseek", ok: true }] }),
      capture: vi.fn().mockImplementation(async () => {
        if (vi.mocked(transport.broadcast).mock.calls.length === 0) {
          return { available: true, results: [{ siteId: "deepseek", ok: true, messages: [] }] };
        }
        const transcript = vi.mocked(transport.broadcast).mock.calls[0][0];
        return { available: true, results: [{
          siteId: "deepseek",
          ok: true,
          generating: true,
          messages: [
            { role: "user", text: transcript },
            { role: "assistant", text: reasoning },
          ],
        }] };
      }),
      continueGeneration: vi.fn(),
    };
    const provider = new AiHubProvider({ apiKey: "", modelId: "deepseek", timeoutMs: 10_000, transport });
    const pending = collect(provider.streamChat([{ role: "user", content: "读取 README" }], { tools }));

    await vi.advanceTimersByTimeAsync(10_100);

    expect(await pending).toEqual([{
      type: "error",
      code: "model_request_timeout",
      message: "AI Hub 抓取回复超过 10 秒（deepseek）：网页仍在生成，未提交可能不完整的内容",
    }]);
  });

  it("clicks 继续生成 when the site truncates its reply, then finishes with the extended reply", async () => {
    vi.useFakeTimers();
    const truncated = "前半段回复";
    const extended = "前半段回复，续写后半段";
    const transport: AiHubTransport = {
      status: vi.fn().mockResolvedValue({ available: true }),
      broadcast: vi.fn().mockResolvedValue({ available: true, results: [{ siteId: "deepseek", ok: true }] }),
      capture: vi.fn().mockImplementation(async () => {
        if (vi.mocked(transport.broadcast).mock.calls.length === 0) {
          return { available: true, results: [{ siteId: "deepseek", ok: true, messages: [] }] };
        }
        const transcript = vi.mocked(transport.broadcast).mock.calls[0][0];
        const resumed = vi.mocked(transport.continueGeneration).mock.calls.length > 0;
        return {
          available: true,
          results: [{
            siteId: "deepseek",
            ok: true,
            pendingContinue: !resumed,
            messages: [
              { role: "user", text: transcript },
              { role: "assistant", text: resumed ? extended : truncated },
            ],
          }],
        };
      }),
      continueGeneration: vi.fn().mockResolvedValue({ available: true, results: [{ siteId: "deepseek", ok: true }] }),
    };
    const provider = new AiHubProvider({ apiKey: "", modelId: "deepseek", transport });
    const pending = collect(provider.streamChat([{ role: "user", content: "写一份长报告" }], { sessionId: "session-continue" }));

    await vi.advanceTimersByTimeAsync(12_100);
    const events = await pending;

    expect(transport.continueGeneration).toHaveBeenCalledWith(["deepseek"], "session-continue");
    expect(events).toEqual([
      { type: "text_chunk", text: extended },
      { type: "text_done" },
    ]);
  });

  it("never returns a truncated reply as success when continue clicks keep failing", async () => {
    vi.useFakeTimers();
    const truncated = "被截断的回复";
    const transport: AiHubTransport = {
      status: vi.fn().mockResolvedValue({ available: true }),
      broadcast: vi.fn().mockResolvedValue({ available: true, results: [{ siteId: "deepseek", ok: true }] }),
      capture: vi.fn().mockImplementation(async () => {
        if (vi.mocked(transport.broadcast).mock.calls.length === 0) {
          return { available: true, results: [{ siteId: "deepseek", ok: true, messages: [] }] };
        }
        const transcript = vi.mocked(transport.broadcast).mock.calls[0][0];
        return {
          available: true,
          results: [{
            siteId: "deepseek",
            ok: true,
            pendingContinue: true,
            messages: [
              { role: "user", text: transcript },
              { role: "assistant", text: truncated },
            ],
          }],
        };
      }),
      continueGeneration: vi.fn().mockResolvedValue({
        available: false,
        reason: "continue-button-not-found",
        results: [{ siteId: "deepseek", ok: false, reason: "continue-button-not-found" }],
      }),
    };
    const provider = new AiHubProvider({ apiKey: "", modelId: "deepseek", transport });
    const pending = collect(provider.streamChat([{ role: "user", content: "写一份长报告" }]));

    await vi.advanceTimersByTimeAsync(40_100);
    const events = await pending;

    expect(transport.continueGeneration).toHaveBeenCalledTimes(5);
    expect(events).toEqual([{
      type: "error",
      message: expect.stringContaining("半截内容未作为最终答案提交"),
    }]);
  });
});
