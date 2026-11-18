import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersistentNotification } from "@agent/core";
import { describe, expect, it, vi } from "vitest";
import ToastNotifications, { notificationPreview } from "./ToastNotifications";

const notification = (id: string, kind: PersistentNotification["kind"] = "completion"): PersistentNotification => ({
  id, ownerId: "owner", sourceEventId: `event:${id}`, kind,
  title: "优化具身智能机器人简历", body: "已完成 **三页优化版**，并逐页检查排版。", createdAt: 123,
  sessionId: "original-session",
});

function buttons(node: ReactNode): ReactElement<{ onClick: (event: { stopPropagation: () => void }) => void; "aria-label": string; className?: string }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return element.type === "button" ? [element as ReturnType<typeof buttons>[number]] : buttons(element.props.children);
}

describe("notification previews", () => {
  it("keeps readable link labels while removing Markdown, code and local paths", () => {
    const preview = notificationPreview("## 已完成\n- **三页优化版**\n[下载 Word 优化版](/Users/caoqu/report.docx)\n`/Users/caoqu/有空格的 文件.docx`\n```ts\nconsole.log('internal');\n```\nC:\\Users\\caoqu\\report.docx\n继续检查。");
    expect(preview).toBe("已完成 三页优化版 下载 Word 优化版 继续检查。");
    expect(preview).not.toMatch(/Users|console|```|\*\*|\.docx/);
  });

  it("bounds long previews without splitting emoji characters", () => {
    expect(notificationPreview("😀😀😀😀😀", 4)).toBe("😀😀😀…");
    expect(notificationPreview("  简短结果  ")).toBe("简短结果");
  });
});

describe("desktop notification toasts", () => {
  it.each([
    ["completion", "完成", "completion", "circle-check"], ["approval", "确认", "approval", "message-circle-question"],
    ["todo_reminder", "提醒", "todo_reminder", "bell-ring"], ["todo_execution", "定时待办执行完成", "todo_execution", "calendar-check2"],
    ["todo_execution", "定时待办需要核实", "todo_attention", "clock-alert"], ["todo_execution", "定时待办执行未完成", "todo_error", "circle-x"],
  ] as const)("distinguishes %s / %s with its semantic icon and color class", (kind, title, type, icon) => {
    const html = renderToStaticMarkup(createElement(ToastNotifications, {
      items: [{ ...notification("typed", kind), title }], onOpen: vi.fn(), onDismiss: vi.fn(),
    }));
    expect(html).toContain(`data-notification-type="${type}"`);
    expect(html).toContain(`notification-toast--${type}`);
    expect(html).toContain(`lucide-${icon}`);
  });

  it("renders at most three compact notifications with separate open and close buttons", () => {
    const html = renderToStaticMarkup(createElement(ToastNotifications, {
      items: [notification("one"), notification("two", "approval"), notification("three", "todo_reminder"), notification("four")],
      onOpen: vi.fn(), onDismiss: vi.fn(),
    }));
    expect(html.match(/<article/g)).toHaveLength(3);
    expect(html).toContain("会话已完成");
    expect(html).toContain("需要确认");
    expect(html).toContain("待办提醒");
    expect(html).toContain("三页优化版");
    expect(html).not.toContain("**");
    expect(html.match(/关闭通知并标为已读/g)).toHaveLength(3);
    expect(html.match(/<\/?button\b/g)).toEqual(Array.from({ length: 6 }, () => ["<button", "</button"]).flat());
  });

  it("opens the original notification and dismisses without propagating or opening it", () => {
    const item = notification("one");
    const onOpen = vi.fn(), onDismiss = vi.fn(), stopPropagation = vi.fn();
    const controls = buttons(ToastNotifications({ items: [item], onOpen, onDismiss }));
    const close = controls.find((button) => button.props["aria-label"] === "关闭通知并标为已读")!;
    close.props.onClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledWith(item);
    expect(onOpen).not.toHaveBeenCalled();
    const open = controls.find((button) => button !== close)!;
    open.props.onClick({ stopPropagation });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it.each(["会话已完成", "会话完成", "任务完成", "任务已完成。", "运行已结束"])("omits the duplicate generic completion title %s", (title) => {
    const html = renderToStaticMarkup(createElement(ToastNotifications, {
      items: [{ ...notification("generic"), title }], onOpen: vi.fn(), onDismiss: vi.fn(),
    }));
    expect(html).toContain("会话已完成");
    expect(html).not.toContain('class="notification-toast__title"');
    expect(html).toContain("三页优化版");
  });

  it("keeps meaningful session titles below the completion label", () => {
    const html = renderToStaticMarkup(createElement(ToastNotifications, {
      items: [notification("specific")], onOpen: vi.fn(), onDismiss: vi.fn(),
    }));
    expect(html).toContain('class="notification-toast__title">优化具身智能机器人简历</strong>');
    expect(html).toContain("会话已完成");
  });

  it("offers clear all only for multiple notifications and invokes the dedicated action", () => {
    const onClearAll = vi.fn(), onOpen = vi.fn(), onDismiss = vi.fn(), stopPropagation = vi.fn();
    const items = [notification("one"), notification("two")];
    const tree = ToastNotifications({ items, onOpen, onDismiss, onClearAll });
    const clear = buttons(tree).find((button) => button.props.className === "notification-toasts__clear")!;
    expect(clear).toBeDefined();
    clear.props.onClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onClearAll).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(tree)).toContain("全部清除");
    const single = renderToStaticMarkup(createElement(ToastNotifications, { items: [items[0]], onOpen, onDismiss, onClearAll }));
    expect(single).not.toContain("全部清除");
  });

  it("renders nothing with no pending notifications and provides a readable empty-body fallback", () => {
    expect(ToastNotifications({ items: [], onOpen: vi.fn(), onDismiss: vi.fn() })).toBeNull();
    const html = renderToStaticMarkup(createElement(ToastNotifications, {
      items: [{ ...notification("path"), body: "`/Users/caoqu/report.docx`" }], onOpen: vi.fn(), onDismiss: vi.fn(),
    }));
    expect(html).toContain("点击查看详细内容");
    expect(html).not.toContain("/Users/");
  });
});
