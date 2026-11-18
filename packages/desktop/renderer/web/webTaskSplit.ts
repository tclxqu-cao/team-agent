import { useEffect, useState } from "react";
import { isWebShell } from "./webLayout";

interface WebTaskSplitDevice {
  width: number;
  userAgent: string;
  coarsePointer: boolean;
  nativeApp: boolean;
}

/** A wide mobile viewport must not turn on a desktop workspace. */
export function supportsWebTaskSplit(device: WebTaskSplitDevice): boolean {
  return Number.isFinite(device.width) && device.width >= 900 && !device.nativeApp && !device.coarsePointer
    && !/Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(device.userAgent);
}

function currentWebTaskSplitEnabled(): boolean {
  return typeof window !== "undefined" && isWebShell() && supportsWebTaskSplit({
    width: window.innerWidth,
    userAgent: navigator.userAgent,
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    nativeApp: document.body.dataset.nativeApp === "1",
  });
}

export function useWebTaskSplitEnabled(): boolean {
  const [enabled, setEnabled] = useState(currentWebTaskSplitEnabled);
  useEffect(() => {
    const update = () => setEnabled(currentWebTaskSplitEnabled());
    const pointer = window.matchMedia("(pointer: coarse)");
    update();
    window.addEventListener("resize", update);
    pointer.addEventListener("change", update);
    return () => {
      window.removeEventListener("resize", update);
      pointer.removeEventListener("change", update);
    };
  }, []);
  return enabled;
}
