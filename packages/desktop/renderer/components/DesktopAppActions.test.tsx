import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DesktopAppActions from "./DesktopAppActions";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("DesktopAppActions", () => {
  it("renders only the calendar in the desktop quick actions", () => {
    const html = renderToStaticMarkup(createElement(DesktopAppActions, {
      onOpenCalendar: () => {},
    }));

    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="应用快捷操作"');
    expect(html).toContain('aria-label="打开日历"');
    expect(html.match(/<button\b/g)).toHaveLength(1);
  });

  it("exposes the shared calendar in both desktop navigation layouts", () => {
    expect(app.match(/onOpenCalendar=\{openCalendar\}/g)).toHaveLength(3);
    expect(app).toContain("<CalendarView loadOverview={loadCalendarOverview}");
    expect(app).toContain("display: hubOpen || calendarOpen");
    expect(app).toContain("useEffect(() => { setCalendarOpen(false); }, [selectedSessionId, selectedProjectId])");
  });

  it("keeps the application toolbar out of the shared web shell", () => {
    expect(app).toContain('{!webShell && navigationLayout === "classic" && (');
    expect(app).toContain('headerAppActions={!webShell && navigationLayout !== "classic"');
    expect(app).toContain("<DesktopAppActions");
  });
});
