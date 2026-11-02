"use client";

import { PanelsTopLeft } from "lucide-react";
import { navigationLayoutSwitchTitle, nextNavigationLayout, type NavigationLayout } from "../../../core/src/domain/web-console/navigation-layout";

export default function NavigationLayoutSwitcher({ value, onChange }: { value: NavigationLayout; onChange(value: NavigationLayout): void }) {
  return <button type="button" className="file-drawer-toggle navigation-layout-toggle" aria-label="切换布局" data-navigation-layout={value}
    title={navigationLayoutSwitchTitle(value)} onClick={() => onChange(nextNavigationLayout(value))}>
    <PanelsTopLeft size={17} aria-hidden="true" />
  </button>;
}
