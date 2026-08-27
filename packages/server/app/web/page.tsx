"use client";
// /web — remote console. Terminal IS the app (fullscreen).
// - phone: terminal fullscreen; file tree = right-edge drawer; preview = sheet
// - ≥900px: [terminal | tree | preview(only when open)] with resizable tree

import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";
import { useGateway } from "./useGateway";

const TerminalPane = dynamic(() => import("./TerminalPane"), { ssr: false });
const FileTree = dynamic(() => import("./FileTree"), { ssr: false });
const FilePreview = dynamic(() => import("./FilePreview"), { ssr: false });

export default function WebConsolePage() {
  const binSinkRef = useRef<((data: Uint8Array) => void) | null>(null);
  const { state, epoch, rpc, onEvent, setTokenAndReconnect } = useGateway(
    useCallback((data) => binSinkRef.current?.(data), []),
  );
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [cwdHint, setCwdHint] = useState<string | null>(null);

  const openFile = useCallback((p: string) => {
    setPreviewPath(p);
    setDrawerOpen(false); // picking a file dismisses the drawer on phones
  }, []);
  const registerSink = useCallback((fn: ((d: Uint8Array) => void) | null) => {
    binSinkRef.current = fn;
  }, []);

  return (
    <div className="web-root" style={S.root}>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      {state.needsToken && (
        <div style={S.tokenGate}>
          <div style={S.tokenCard}>
            <div style={{ fontSize: 15, marginBottom: 8 }}>🔒 访问令牌</div>
            <div style={{ fontSize: 12.5, color: "#889", lineHeight: 1.6, marginBottom: 14 }}>
              启动 gateway 时控制台会打印 token（或设置 AGENT_WEB_TOKEN 固定值）。
            </div>
            <input
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="paste token"
              style={S.tokenInput}
            />
            <button onClick={() => setTokenAndReconnect(tokenInput)} style={S.tokenBtn}>
              连接
            </button>
          </div>
        </div>
      )}

      {/* slim top bar */}
      <header style={S.topbar}>
        <span style={{ fontWeight: 600, letterSpacing: 0.2, fontSize: 13 }}>remote console</span>
        {cwdHint && (
          <span className="cwd-hint" style={S.cwdHint} title={cwdHint}>
            {cwdHint}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            width: 8,
            height: 8,
            borderRadius: 99,
            background: state.connected ? "#9ece6a" : "#f7768e",
          }}
        />
      </header>

      {/* workspace: terminal first in DOM = fullscreen by default */}
      <main
        className={`workspace ${drawerOpen ? "show-tree" : ""} ${previewPath ? "has-preview" : ""}`}
        style={S.workspace}
      >
        {/* terminal — always mounted, always the base layer */}
        <section className="term-col" style={S.termCol}>
          <TerminalPane
            key={epoch}
            state={state}
            rpc={rpc}
            onEvent={onEvent}
            registerSink={registerSink}
            onCwdChange={setCwdHint}
          />
        </section>

        {/* file tree — right sidebar on desktop / right drawer on phone.
            Mounted only when opened so it never steals layout space. */}
        {drawerOpen && <div className="drawer-mask" onClick={() => setDrawerOpen(false)} />}
        <aside className={`tree-col ${drawerOpen ? "tree-col-open" : ""}`} style={S.treeCol}>
          <div className="tree-head" style={S.treeHead}>
            <span>文件</span>
            <span className="tree-cwd" style={S.treeCwd}>{cwdHint ?? ""}</span>
            <button
              style={{ ...S.iconBtn, marginLeft: "auto", flexShrink: 0 }}
              onClick={() => setDrawerOpen(false)}
              aria-label="close drawer"
            >
              ✕
            </button>
          </div>
          <FileTree
            ready={epoch > 0}
            followCwd={true}
            cwd={cwdHint}
            rpc={rpc}
            onEvent={onEvent}
            onOpenFile={openFile}
            selectedPath={previewPath}
          />
          <div style={S.treeFoot}>
            <span style={S.treeFootDot} />
            <span>实时同步</span>
          </div>
        </aside>

        {/* preview — third column when a file is tapped */}
        {previewPath && (
          <section className="preview-col" style={S.previewCol}>
            <FilePreview path={previewPath} rpc={rpc} onClose={() => setPreviewPath(null)} />
          </section>
        )}
      </main>

      {/* floating action: toggle file drawer (both mobile & desktop) */}
      <button className="fab-files" style={S.fabFiles} onClick={() => setDrawerOpen((v) => !v)} aria-label="files">
        📂
      </button>
    </div>
  );
}

const GLOBAL_CSS = `
  html, body { margin: 0; background: #0b0b10; overscroll-behavior: none; }
  * { -webkit-tap-highlight-color: transparent; }
  .web-root {
    position: fixed;
    top: var(--vv-top, 0px);
    left: 0;
    right: 0;
    height: var(--vv-height, 100dvh) !important;
  }
  .tree-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
    padding: 6px;
  }
  .tree-location {
    position: sticky;
    top: -6px;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 5px;
    margin: -1px -1px 0;
    padding: 7px 7px 5px;
    background: rgba(18,18,24,.98);
  }
  .tree-location input {
    flex: 1;
    min-width: 0;
    height: 28px;
    border: 1px solid #30303b;
    border-radius: 6px;
    outline: none;
    padding: 0 8px;
    background: #0f0f15;
    color: #d8d8df;
    font-family: "SF Mono", Menlo, monospace;
    font-size: 10.5px;
  }
  .tree-location input:focus { border-color: #536b9e; }
  .tree-location button {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: 1px solid #30303a;
    border-radius: 6px;
    background: #202029;
    color: #aaaab8;
    font-size: 12px;
  }
  .tree-location button[data-active="1"] {
    border-color: #4f6f58;
    color: #9ece6a;
    background: #18221b;
  }
  .tree-filter {
    position: sticky;
    top: 34px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: -1px -1px 7px;
    padding: 7px 8px;
    border-bottom: 1px solid #25252e;
    background: rgba(18,18,24,.97);
    color: #666678;
    backdrop-filter: blur(8px);
  }
  .tree-filter input {
    flex: 1;
    min-width: 0;
    height: 27px;
    border: 1px solid #30303a;
    border-radius: 6px;
    outline: none;
    padding: 0 8px;
    background: #0f0f15;
    color: #d8d8df;
    font-size: 11px;
  }
  .tree-filter input:focus { border-color: #536b9e; }
  .tree-filter button {
    width: 25px;
    height: 25px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: #24242d;
    color: #9999a6;
    font-size: 10px;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 31px;
    padding-right: 7px;
    border-radius: 6px;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
  }
  .tree-row[data-selected="1"] { background: #26304a; }
  .tree-size { margin-left: auto; color: #555; font-size: 10px; flex-shrink: 0; }

  /* phone-first: terminal is THE screen */
  .workspace { display: grid !important; grid-template-columns: 1fr; }
  .tree-col {
    position: fixed;
    top: var(--vv-top, 0px);
    height: var(--vv-height, 100dvh);
    right: 0;
    width: min(82vw, 320px); z-index: 40;
    transform: translateX(102%); transition: transform .22s ease;
    box-shadow: -12px 0 32px rgba(0,0,0,.5);
  }
  .tree-col-open { transform: translateX(0); }
  .drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 39; }
  .preview-col {
    position: fixed;
    top: var(--vv-top, 0px);
    left: 0;
    right: 0;
    height: var(--vv-height, 100dvh);
    z-index: 50;
    background: #101014;
  }
  .fab-files { display: grid; place-items: center; }
  .cwd-hint { max-width: 40vw; }

  @media (min-width: 900px) {
    .workspace.has-preview { grid-template-columns: 1fr minmax(220px, 264px) minmax(320px, 34%); }
    .workspace:not(.has-preview) { grid-template-columns: 1fr minmax(220px, 264px); }
    /* desktop: tree is a persistent right column; hidden only via transform off */
    .tree-col {
      position: static; top: auto; height: auto; width: auto; transform: none;
      box-shadow: none; border-left: 1px solid #1e1e26;
    }
    .workspace:not(.show-tree) .tree-col { display: none; }
    .preview-col { position: relative; inset: auto; height: auto; border-left: 1px solid #1e1e26; }
    .fab-files { display: none; }
    .drawer-mask { display: none; }
  }
`;

const S: Record<string, React.CSSProperties> = {
  root: {
    height: "100dvh",
    display: "flex",
    flexDirection: "column",
    background: "#0b0b10",
    color: "#e8e8ee",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif',
    overflow: "hidden",
  },
  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "calc(env(safe-area-inset-top) + 7px) 12px 7px",
    borderBottom: "1px solid #1c1c24",
    fontSize: 13,
    flexShrink: 0,
  },
  cwdHint: {
    fontSize: 11,
    color: "#667",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    direction: "rtl" as const, // keep tail visible
    textAlign: "left" as const,
  },
  iconBtn: {
    minWidth: 28,
    height: 28,
    borderRadius: 7,
    border: "1px solid #333",
    background: "#17171d",
    color: "#ccc",
    fontSize: 13,
  },
  workspace: {
    flex: 1,
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: "1fr",
    position: "relative",
  },
  treeCol: {
    background: "#121218",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  treeHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px 4px",
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    color: "#778",
    flexShrink: 0,
  },
  treeCwd: {
    fontSize: 10,
    color: "#556",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 150,
    textTransform: "none" as const,
    letterSpacing: 0,
  },
  treeFoot: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    minHeight: 31,
    padding: "6px 11px calc(env(safe-area-inset-bottom) + 6px)",
    borderTop: "1px solid #282832",
    boxShadow: "0 -5px 16px rgba(0,0,0,.22)",
    background: "#15151c",
    color: "#777789",
    fontSize: 10.5,
    flexShrink: 0,
  },
  treeFootDot: {
    width: 6,
    height: 6,
    borderRadius: 99,
    background: "#9ece6a",
    boxShadow: "0 0 0 2px rgba(158,206,106,.12)",
    flexShrink: 0,
  },
  termCol: {
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: "#101014",
    gridColumn: 1,
  },
  previewCol: { minWidth: 0, minHeight: 0 },
  fabFiles: {
    position: "fixed",
    right: 14,
    bottom: "calc(env(safe-area-inset-bottom) + 64px)",
    width: 44,
    height: 44,
    borderRadius: 99,
    border: "1px solid #2c2c38",
    background: "#1b1b26",
    color: "#dde",
    fontSize: 18,
    zIndex: 45,
    boxShadow: "0 4px 16px rgba(0,0,0,.45)",
  },
  tokenGate: {
    position: "fixed",
    inset: 0,
    zIndex: 90,
    background: "rgba(5,5,8,.92)",
    display: "grid",
    placeItems: "center",
    padding: 20,
  },
  tokenCard: {
    width: "min(420px, 100%)",
    background: "#15151c",
    border: "1px solid #2a2a33",
    borderRadius: 16,
    padding: "26px 24px",
  },
  tokenInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "11px 13px",
    borderRadius: 10,
    border: "1px solid #333",
    background: "#0e0e13",
    color: "#eee",
    fontSize: 14,
    marginBottom: 12,
  },
  tokenBtn: {
    width: "100%",
    padding: "11px 0",
    borderRadius: 10,
    border: "none",
    background: "#7aa2f7",
    color: "#0b0b10",
    fontSize: 14,
    fontWeight: 700,
  },
};
