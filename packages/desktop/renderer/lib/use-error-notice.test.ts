import { describe, expect, it } from "vitest";
import { errorNoticeReducer, initialErrorNoticeState, type ErrorNotice } from "./use-error-notice";

const failure: ErrorNotice = { source: "list", title: "加载失败", message: "Load failed" };

describe("dismissible errors during background polling", () => {
  it("keeps an acknowledged failure closed across repeated polls", () => {
    let state = errorNoticeReducer(initialErrorNoticeState, { type: "report", notice: failure, repeat: false });
    state = errorNoticeReducer(state, { type: "dismiss" });
    for (let i = 0; i < 3; i++) state = errorNoticeReducer(state, { type: "report", notice: failure, repeat: false });
    expect(state.notice).toBeNull();
  });

  it("clears stale errors on recovery and reports a later outage", () => {
    let state = errorNoticeReducer(initialErrorNoticeState, { type: "report", notice: failure, repeat: false });
    state = errorNoticeReducer(state, { type: "recover", source: "list" });
    expect(state.notice).toBeNull();
    state = errorNoticeReducer(state, { type: "report", notice: failure, repeat: false });
    expect(state.notice).toEqual(failure);
  });

  it("lets an explicit retry report the same failure again", () => {
    let state = errorNoticeReducer(initialErrorNoticeState, { type: "report", notice: failure, repeat: false });
    state = errorNoticeReducer(state, { type: "dismiss" });
    state = errorNoticeReducer(state, { type: "report", notice: failure, repeat: true });
    expect(state.notice).toEqual(failure);
  });

  it("does not hide an account action failure when list polling succeeds", () => {
    const action = { ...failure, source: "action", message: "macOS 拒绝读取企微数据目录" };
    let state = errorNoticeReducer(initialErrorNoticeState, { type: "report", notice: failure, repeat: false });
    state = errorNoticeReducer(state, { type: "report", notice: action, repeat: true });
    state = errorNoticeReducer(state, { type: "recover", source: "list" });
    expect(state.notice).toEqual(action);
  });

  it("shows a changed failure after the previous message was acknowledged", () => {
    let state = errorNoticeReducer(initialErrorNoticeState, { type: "report", notice: failure, repeat: false });
    state = errorNoticeReducer(state, { type: "dismiss" });
    const changed = { ...failure, message: "服务连接已断开" };
    state = errorNoticeReducer(state, { type: "report", notice: changed, repeat: false });
    expect(state.notice).toEqual(changed);
  });
});
