"use client";

import { useEffect, useState, type ReactNode } from "react";

/** Restore a tab without starting its UI until first selected; retain it afterwards. */
export default function DeferredTabContent({ active, children }: { active: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(active);
  useEffect(() => { if (active) setOpened(true); }, [active]);
  return active || opened ? children : null;
}
