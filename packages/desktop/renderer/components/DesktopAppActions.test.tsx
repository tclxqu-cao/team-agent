import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DesktopAppActions from "./DesktopAppActions";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("DesktopAppActions", () => {
  it("renders Flow Studio as an application-level icon action", () => {
    const html = renderToStaticMarkup(createElement(DesktopAppActions, {
      onOpenFlowStudio: () => {},
    }));

    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="应用快捷操作"');
    expect(html).toContain('aria-label="打开 Flow Studio"');
    expect(html).toContain("desktop-app-action--flow-studio");
  });

  it("exposes the shared calendar in both desktop navigation layouts", () => {
    const html = renderToStaticMarkup(createElement(DesktopAppActions, {
      onOpenFlowStudio: () => {}, onOpenCalendar: () => {},
    }));
    expect(html).toContain('aria-label="打开日历"');
    expect(app.match(/onOpenCalendar=\{openCalendar\}/g)).toHaveLength(3);
    expect(app).toContain("<CalendarView loadOverview={loadCalendarOverview}");
    expect(app).toContain("display: hubOpen || calendarOpen");
    expect(app).toContain("useEffect(() => { setCalendarOpen(false); }, [selectedSessionId, selectedProjectId])");
  });

  it("keeps the application toolbar out of the shared web shell", () => {
    expect(app).toContain('{!webShell && navigationLayout === "classic" && (');
    expect(app).toContain('headerAppActions={!webShell && navigationLayout !== "classic"');
    expect(app).toContain("<DesktopAppActions");
    expect(app).toContain("onOpenFlowStudio={handleOpenFlowStudio}");
    expect(app).toContain("openingFlowStudio={flowStudioOpening}");
  });

  it("opens Flow Studio inside the desktop content area and hides the sidebar", () => {
    expect(app).toContain('import DesktopFlowStudioView from "./components/DesktopFlowStudioView"');
    expect(app).toContain('const [flowStudioEntryUrl, setFlowStudioEntryUrl] = useState<string | null>(null)');
    expect(app).toContain('{layout !== "focus" && !flowStudioEntryUrl && (');
    expect(app).toContain("<DesktopFlowStudioView");
    expect(app).toContain("entryUrl={flowStudioEntryUrl}");
    expect(app).toContain("onBack={() => setFlowStudioEntryUrl(null)}");
    expect(app).not.toContain("openDesktopFlowStudioEntry");
  });
});
