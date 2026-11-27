import { describe, expect, it, vi } from "vitest";
import {
  createOpenCodeQuestionClient, isOpenCodeQuestionId, openCodeFormQuestion,
  openCodeQuestionId, OPENCODE_QUESTION_ASKED, OPENCODE_QUESTION_RESOLVED,
} from "./opencode-questions.js";
import { OpenCodeV2EventCodec } from "./opencode-v2-codec.js";
import { createOpenCodeV2Client } from "./opencode-v2-transport.js";

const form = {
  id: "frm_1", sessionID: "ses_1", metadata: { kind: "question" },
  fields: [
    { key: "q0", type: "string", title: "方式", description: "选择哪种方式？", options: [{ value: "native", label: "原生动画", description: "动态绘制" }], custom: true },
    { key: "q1", type: "multiselect", description: "选择功能", options: [{ value: "a", label: "字幕" }, { value: "b", label: "图表" }] },
    { key: "q2", type: "string", description: "补充要求" },
  ],
};
const json = (value: unknown) => new Response(JSON.stringify(value));

describe("OpenCode question protocols", () => {
  it("converts nested Form identity and native option values, ignoring non-question forms", () => {
    const codec = new OpenCodeV2EventCodec(new Map());
    const [event] = codec.convert({ type: "form.created", location: { directory: "/repo" }, data: { form } });
    expect(event).toMatchObject({ directory: "/repo", payload: { type: OPENCODE_QUESTION_ASKED, properties: {
      id: "frm_1", sessionID: "ses_1", protocol: "form", questions: [
        { question: "选择哪种方式？", options: [{ value: "native", label: "原生动画" }] },
        { multiSelect: true }, { options: [] },
      ],
    } } });
    expect(codec.convert({ type: "form.created", data: { form: { ...form, metadata: { kind: "settings" } } } })).toEqual([]);
    for (const type of ["form.replied", "form.cancelled"]) {
      expect(codec.convert({ type, data: { id: "frm_1", sessionID: "ses_1" } })[0])
        .toMatchObject({ payload: { type: OPENCODE_QUESTION_RESOLVED, properties: { id: "frm_1", sessionID: "ses_1" } } });
    }
  });

  it("uses authenticated Form routes and scalar/array answers on the actual OpenCode 2 API", async () => {
    const calls: Array<{ path: string; method: string | undefined; body: unknown }> = [];
    const fetchRequest = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Basic private");
      calls.push({ path: new URL(String(url)).pathname, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return init?.method === "GET" ? json({ data: [form, { ...form, id: "other", sessionID: "other" }] }) : new Response(null, { status: 204 });
    });
    const client = createOpenCodeV2Client("http://opencode.test", "Basic private", fetchRequest);
    const [request] = await client.questions!.list("ses_1", "/repo");
    await client.questions!.reply(request, [["native"], ["b", "a"], ["保留留白"]], "/repo");
    expect(calls).toEqual([
      { path: "/api/session/ses_1/form", method: "GET", body: undefined },
      { path: "/api/session/ses_1/form/frm_1/reply", method: "POST", body: { answer: { q0: "native", q1: ["b", "a"], q2: "保留留白" } } },
    ]);
    expect(await client.questions!.list("ses_1", "/repo")).toHaveLength(1);
  });

  it("retains legacy question routes, project directory, and ordered answer arrays", async () => {
    const calls: Array<{ url: URL; body: unknown }> = [];
    const client = createOpenCodeQuestionClient("http://opencode.test", "question", undefined, async (url, init) => {
      calls.push({ url: new URL(String(url)), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return init?.method === "GET" ? json([{ id: "que_1", sessionID: "ses_1", questions: [{ question: "哪一种？", options: [{ label: "第一种" }] }] }]) : json(true);
    });
    const [request] = await client.list("ses_1", "/repo/with space");
    expect(request.protocol).toBe("question");
    await client.reply(request, [["第一种"]], "/repo/with space");
    expect(calls.map(({ url }) => url.pathname)).toEqual(["/question", "/question/que_1/reply"]);
    expect(calls.every(({ url }) => url.searchParams.get("directory") === "/repo/with space")).toBe(true);
    expect(calls[1].body).toEqual({ answers: [["第一种"]] });
  });

  it("rejects malformed fields and native failed replies, with stable card IDs distinct from permission IDs", async () => {
    expect(() => openCodeFormQuestion({ ...form, fields: [{ key: "q0", type: "number" }] })).toThrow("question field");
    const request = openCodeFormQuestion(form)!;
    const id = openCodeQuestionId(request, 0);
    expect(isOpenCodeQuestionId(id)).toBe(true);
    expect(openCodeQuestionId(request, 1)).not.toBe(id);
    expect(isOpenCodeQuestionId("opencode:ses_1:perm_1")).toBe(false);
    const client = createOpenCodeQuestionClient("http://opencode.test", "form", "Basic private", async () => new Response("no", { status: 500 }));
    await expect(client.reply(request, [["native"], [], ["text"]], "/repo")).rejects.toThrow("HTTP 500");
  });
});
