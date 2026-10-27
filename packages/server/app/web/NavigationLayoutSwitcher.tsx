"use client";

import { PanelsTopLeft } from "lucide-react";
import { nextNavigationLayout, type NavigationLayout } from "../../../core/src/domain/web-console/navigation-layout";

export default function NavigationLayoutSwitcher({ value, onChange }: { value: NavigationLayout; onChange(value: NavigationLayout): void }) {
  const rail = value === "agent-rail";
  return <button type="button" className="file-drawer-toggle navigation-layout-toggle" aria-label="切换布局" aria-pressed={rail}
    title={rail ? "单层抬头 · 切换到原布局" : "原布局 · 切换到单层抬头"} onClick={() => onChange(nextNavigationLayout(value))}>
    <PanelsTopLeft size={17} aria-hidden="true" />
  </button>;
}
