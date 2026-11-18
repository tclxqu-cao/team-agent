import { useEffect, useState } from "react";
import CalendarView from "../../../desktop/renderer/components/CalendarView";
import { useUIStore } from "@desktop/renderer/stores/uiStore";
import type { CalendarOverview } from "@agent/core";

export default function CalendarPage() {
  const [skin, setSkin] = useState(useUIStore.getState().skin);
  useEffect(() => useUIStore.subscribe(state => setSkin(state.skin)), []);
  useEffect(() => { document.documentElement.dataset.skin = skin; }, [skin]);
  return (
    <CalendarView initialTaskId={new URLSearchParams(location.search).get("task") ?? undefined} loadOverview={async (from, to): Promise<CalendarOverview> => {
      const api = window.agentApi;
      if (!api?.calendarOverview) throw new Error("当前环境不支持日历视图");
      return api.calendarOverview({ from, to });
    }} />
  );
}