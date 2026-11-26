import { useEffect, useState } from "react";
import type { NativeComposerCatalog } from "../../../shared/src/contracts/agent-api";

const EMPTY_CATALOG: NativeComposerCatalog = { skills: [], files: [] };

export function useCodexComposerCatalog(cwd: string, showSkills: boolean, fileQuery: string | null): NativeComposerCatalog {
  const key = JSON.stringify([cwd, showSkills, fileQuery]);
  const [result, setResult] = useState<{ key: string; catalog: NativeComposerCatalog }>();
  useEffect(() => {
    const api = window.agentApi;
    const query = showSkills ? undefined : fileQuery?.trim();
    if (!api?.getCodexComposerCatalog || (!showSkills && (!query || !cwd))) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.getCodexComposerCatalog!(cwd, query, controller.signal)
        .then(catalog => {
          if (!controller.signal.aborted) setResult({ key, catalog });
        }).catch(() => undefined);
    }, showSkills ? 0 : 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [cwd, fileQuery, key, showSkills]);
  return result?.key === key ? result.catalog : EMPTY_CATALOG;
}
