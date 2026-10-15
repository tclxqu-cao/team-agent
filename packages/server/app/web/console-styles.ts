export const CONSOLE_CSS = `
  .web-root.is-remote-fullscreen > .terminal-tabs { display: none; }
  .web-root.is-remote-fullscreen .tree-col,
  .web-root.is-remote-fullscreen .preview-col { display: none; }

  html, body { width:100%; height:100%; margin:0; overflow:hidden; background:var(--ui-root-bg, #0b0b10); overscroll-behavior:none; color:var(--ui-text, #e8e8ee); }
  * { -webkit-tap-highlight-color: transparent; }
  .terminal-tabs { display:flex; align-items:end; gap:4px; min-height:38px; padding:0 8px; background:var(--ui-tabbar-bg, #12141b); border-bottom:0; flex-shrink:0; }
  .terminal-tab-list[hidden],.terminal-add[hidden]{display:none}
  .computer-page-heading{display:flex;align-items:center;gap:4px;flex:1;min-width:0;color:var(--ui-text,#e8e8ee);font-size:13px}.computer-page-heading>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.computer-page-heading a{text-decoration:none;display:grid;place-items:center;flex-shrink:0}
  .computer-page-pane{position:relative;flex:1;min-height:0;background:var(--ui-root-bg,#0b0b10)}.computer-page-pane>iframe{width:100%;height:100%;border:0;display:block}.computer-page-fallback{position:absolute;bottom:32px;left:50%;transform:translateX(-50%);color:var(--ui-tab-accent,#7aa2f7);font-size:13px;z-index:2}
  .computer-page-blocked{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding:24px;color:var(--ui-text,#e8e8ee)}.computer-page-blocked h2{font-size:20px;margin:0}.computer-page-blocked p{max-width:420px;line-height:1.7;color:var(--ui-muted-text,#999dab);margin:0}.computer-page-blocked a{display:flex;align-items:center;gap:8px;padding:12px 18px;border-radius:8px;background:var(--ui-tab-accent,#7aa2f7);color:var(--ui-root-bg,#0b0b10);text-decoration:none}
  .terminal-tab-list { position:relative; display:flex; align-items:end; gap:4px; flex:0 1 auto; min-width:0; height:100%; overflow-x:auto; overflow-y:hidden; touch-action:pan-x; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; scroll-behavior:smooth; scrollbar-width:none; }
  .terminal-tab { display:flex; align-items:center; flex-shrink:0; gap:7px; min-width:74px; max-width:130px; height:32px; padding:0 7px 0 10px; border-radius:7px 7px 0 0; background:var(--ui-tab-bg, #1b1e28); color:var(--ui-tab-text, #8f93a4); font-size:11px; cursor:pointer; box-sizing:border-box; transition:color .2s ease,box-shadow .2s ease; }
  .terminal-tab.active { color:var(--ui-tab-active-text, #edf0f7); background:var(--ui-active-content-bg, var(--ui-tab-active-bg, #262b38)); box-shadow:inset 0 2px var(--ui-tab-accent, #7aa2f7); }
  .terminal-tab span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .terminal-tab button { width:18px; height:18px; border:0; border-radius:4px; background:transparent; color:var(--ui-tab-text, #707586); padding:0; }
  .terminal-add { flex-shrink:0; min-width:30px; height:28px; margin-bottom:2px; border:1px solid var(--ui-tabbar-border, #303442); border-radius:6px; background:var(--ui-tab-bg, #1b1e28); color:var(--ui-tab-text, #9da2b2); }
  .terminal-connection { align-self:stretch; display:flex; align-items:center; margin-left:auto; padding:0 9px; background:var(--ui-connection-bg, #12141b); color:var(--ui-connection-text, #777b8c); font-size:10.5px; flex-shrink:0; z-index:5; }
  .file-drawer-toggle { display:grid; place-items:center; width:28px; height:28px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--ui-connection-text, #777b8c); cursor:pointer; flex-shrink:0; touch-action:manipulation; }
  .file-drawer-toggle:hover, .file-drawer-toggle[aria-expanded="true"] { background:color-mix(in srgb, var(--ui-tab-accent, #7aa2f7) 12%, transparent); color:var(--ui-tab-active-text, #edf0f7); }
  .file-drawer-toggle:focus-visible { outline:2px solid var(--ui-tab-accent, #7aa2f7); outline-offset:-2px; }
  .theme-avatar-with-status { position:relative; display:flex; flex-shrink:0; }
  .theme-avatar-status { position:absolute; right:-2px; bottom:-2px; z-index:7; width:6px; height:6px; box-sizing:border-box; border:1px solid var(--ui-connection-bg, #12141b); border-radius:50%; background:var(--ui-error); pointer-events:none; }
  .theme-avatar-status[data-connected="true"] { background:var(--ui-success); }
  .theme-picker { position:relative; display:flex; align-items:center; flex-shrink:0; }
  .responsive-toolbar { position:relative; display:flex; align-items:center; flex-shrink:0; gap:0; z-index:6; }
  .toolbar-avatar, .toolbar-slot { display:flex; align-items:center; flex-shrink:0; }
  .toolbar-size-measure { position:fixed; top:-1000px; visibility:hidden; pointer-events:none; }
  .toolbar-tools { display:flex; align-items:center; flex-shrink:0; gap:0; }
  .toolbar-tools-expanded { flex-wrap:wrap; padding:4px; }
  .theme-avatar { position:relative; display:flex; align-items:center; justify-content:center; width:18px; height:18px; padding:0; border-radius:99px; font-size:9px; font-weight:700; cursor:pointer; flex-shrink:0; touch-action:manipulation; -webkit-tap-highlight-color:transparent; transition:transform .12s ease, filter .12s ease; }
  /* Hit-area padding keeps the compact visual circle easy to target. */
  .theme-avatar::after { content:""; position:absolute; inset:-6px; border-radius:99px; }
  .theme-avatar:active { transform:scale(.9); filter:brightness(1.15); }
  .theme-popover-item { display:flex; align-items:center; gap:8px; padding:7px 8px; border:none; border-radius:8px; cursor:pointer; touch-action:manipulation; -webkit-tap-highlight-color:transparent; }
  .theme-popover-item:active { background:color-mix(in srgb, var(--ui-tab-accent, #7aa2f7) 22%, transparent); }
  /* Touch devices: keep hit areas tall while packing icons horizontally.
     The tab bar must grow in step — it clips overflow-y, so an expanded
     hit area taller than the bar would get cut off. */
  @media (pointer: coarse) {
    .terminal-tabs { min-height:44px; }
    .theme-avatar-with-status { width:36px; height:44px; align-items:center; justify-content:center; }
    .theme-avatar::after { inset:-13px -9px; }
    .theme-avatar-status { right:6px; bottom:10px; }
    .toolbar-tools .file-drawer-toggle, .responsive-toolbar .file-drawer-toggle { width:32px; height:40px; }
    .theme-popover-item { padding-top:11px; padding-bottom:11px; }
  }
  @media (prefers-reduced-motion: reduce) { .theme-avatar { transition:none; } }
  .terminal-track { display:flex; width:100%; height:100%; will-change:transform; }
  .terminal-slide { position:relative; flex:0 0 100%; width:100%; height:100%; min-width:0; overflow:hidden; }
  .webapp-frame { display:block; width:100%; height:100%; border:0; background:var(--ui-term-col-bg, #101014); }
  .terminal-surface { position:relative; flex:1; min-height:90px; overflow:hidden; }
  .terminal-screen { display:flex; flex-direction:column; width:100%; min-height:0; overflow:hidden; box-sizing:border-box; }
  .terminal-screen .xterm { flex:1; height:100%; background:var(--ui-terminal-bg, #101014); }
  .terminal-screen .xterm .xterm-viewport { background-color:var(--ui-terminal-bg, #101014); }
  .terminal-screen .xterm-scrollable-element { touch-action:pan-y; -webkit-overflow-scrolling:touch; }
  .terminal-boot { position:absolute; inset:0; z-index:46; display:flex; align-items:center; justify-content:center; gap:9px; pointer-events:auto; font-size:12px; line-height:1.4; letter-spacing:0; }
  .terminal-boot-spinner { width:16px; height:16px; box-sizing:border-box; border:2px solid color-mix(in srgb,currentColor 24%,transparent); border-top-color:currentColor; border-radius:50%; animation:terminal-boot-spin .8s linear infinite; }
  .terminal-boot-warning { position:absolute; top:9px; left:50%; z-index:45; transform:translateX(-50%); max-width:calc(100% - 24px); padding:5px 8px; border:1px solid; border-radius:6px; pointer-events:none; font-size:11px; line-height:1.35; letter-spacing:0; white-space:normal; text-align:center; }
  @keyframes terminal-boot-spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .terminal-track,.terminal-tab { transition:none !important; } .terminal-boot-spinner { animation:none !important; } }
  .web-root {
    position: fixed;
    top: var(--vv-top, 0px);
    left: var(--vv-left, 0px);
    width: var(--vv-width, 100vw);
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
    background: color-mix(in srgb, var(--ui-tree-bg, #121218) 98%, transparent);
  }
  .tree-location input {
    flex: 1;
    min-width: 0;
    height: 28px;
    border: 1px solid var(--ui-panel-input-border, #30303b);
    border-radius: 6px;
    outline: none;
    padding: 0 8px;
    background: var(--ui-panel-input-bg, #0f0f15);
    color: var(--ui-panel-input-text, #d8d8df);
    font-family: "SF Mono", Menlo, monospace;
    font-size: 10.5px;
  }
  .tree-location input:focus { border-color: var(--ui-tab-accent, #536b9e); }
  .tree-location button {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: 1px solid var(--ui-panel-input-border, #30303a);
    border-radius: 6px;
    background: var(--ui-tab-bg, #202029);
    color: var(--ui-tab-text, #aaaab8);
    font-size: 12px;
  }
  .tree-location button[data-active="1"] {
    border-color: var(--ui-success, #4f6f58);
    color: var(--ui-success, #9ece6a);
    background: color-mix(in srgb, var(--ui-success, #9ece6a) 12%, var(--ui-tree-bg, #18221b));
  }
  .tree-head button { height:26px; padding:0 10px; border:0; border-radius:6px 6px 0 0; background:transparent; color:var(--ui-drawer-tab-text, #74798a); font-size:11px; }
  .tree-head button.drawer-tab-active { color:var(--ui-drawer-tab-active, #e4e7ef); box-shadow:inset 0 -2px var(--ui-tab-accent, #7aa2f7); }
  .history-panel { flex:1; min-height:0; overflow:auto; padding:7px; }
  .pinned-commands { position:sticky; top:0; z-index:3; margin:-1px -1px 7px; border:1px solid var(--ui-tabbar-border, #252832); border-radius:6px; background:var(--ui-tree-bg, #121218); box-shadow:0 7px 12px color-mix(in srgb, var(--ui-root-bg, #0b0b10) 58%, transparent); overflow:hidden; }
  .pinned-command-head { display:flex; align-items:center; min-height:30px; padding:0 6px 0 10px; border-bottom:1px solid var(--ui-tabbar-border, #252832); color:var(--ui-history-meta, #74798a); font-size:10px; }
  .pinned-command-head span { flex:1; }
  .pinned-command-row { display:flex; align-items:center; min-height:34px; border-bottom:1px solid color-mix(in srgb, var(--ui-tabbar-border, #252832) 76%, transparent); cursor:pointer; outline:none; }
  .pinned-command-row:last-child { border-bottom:0; }
  .pinned-command-row:hover,.pinned-command-row:focus-visible { background:color-mix(in srgb, var(--ui-tab-active-bg, #1f2430) 76%, transparent); }
  .pinned-command-row:focus-visible { box-shadow:inset 2px 0 var(--ui-tab-accent, #7aa2f7); }
  .pinned-command-dragging { opacity:.66; background:var(--ui-tab-active-bg, #1f2430); }
  .pinned-command-row code { flex:1; min-width:0; padding:0 5px; overflow:hidden; color:var(--ui-history-item-text, #d3d6df); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
  .pinned-command-grip { display:inline-flex; align-items:center; justify-content:center; width:28px; height:32px; padding:0; border:0; background:transparent; color:var(--ui-history-meta, #626777); cursor:grab; touch-action:none; }
  .pinned-command-grip:active { cursor:grabbing; }
  .pinned-command-actions { display:flex; align-items:center; padding-right:3px; opacity:.42; transition:opacity .15s ease; }
  .pinned-command-row:hover .pinned-command-actions,.pinned-command-row:focus-within .pinned-command-actions { opacity:1; }
  .pinned-command-editor { display:grid; grid-template-columns:minmax(0,1fr) 27px 27px; gap:4px; align-items:center; min-height:39px; padding:4px 5px 4px 8px; border-bottom:1px solid var(--ui-tabbar-border, #252832); }
  .pinned-command-editor input { min-width:0; height:27px; box-sizing:border-box; border:1px solid var(--ui-tab-accent, #536b9e); border-radius:5px; outline:none; padding:0 7px; background:var(--ui-panel-input-bg, #0f0f15); color:var(--ui-panel-input-text, #ddd); font-family:"SF Mono",Menlo,monospace; font-size:10.5px; }
  .pinned-command-editor small { grid-column:1 / -1; color:var(--ui-danger, #e06c75); font-size:9px; }
  .terminal-clipboard-notice { padding:4px 8px; flex-shrink:0; font-size:12px; }
  .terminal-native-touch, .terminal-native-touch .xterm-screen, .terminal-native-touch .terminal-native-rows, .terminal-native-touch .terminal-native-rows * { -webkit-user-select:text !important; user-select:text !important; -webkit-touch-callout:default; }
  .terminal-native-touch .terminal-native-rows { position:absolute; top:0; left:0; z-index:4; pointer-events:auto !important; }
  .terminal-native-touch .xterm-rows:not(.terminal-native-rows) { -webkit-user-select:none !important; user-select:none !important; }
  .terminal-native-touch .terminal-native-rows span { display:inline !important; }
  .terminal-native-touch .xterm-helper-textarea { opacity:1; background:transparent; color:transparent; -webkit-text-fill-color:transparent; caret-color:transparent; outline:none; text-shadow:none; -webkit-appearance:none; appearance:none; -webkit-user-select:text; user-select:text; -webkit-touch-callout:default; font-size:16px !important; left:var(--native-input-left, 0px) !important; top:var(--native-input-top, 0px) !important; width:var(--native-input-width, 80px) !important; height:var(--native-input-height, 32px) !important; z-index:10 !important; pointer-events:var(--native-input-events, none); }
  .history-search { display:flex; gap:5px; padding:5px; background:var(--ui-tree-bg, #121218); }
  .history-search input { flex:1; min-width:0; height:28px; border:1px solid var(--ui-panel-input-border, #30303a); border-radius:6px; padding:0 8px; background:var(--ui-panel-input-bg, #0f0f15); color:var(--ui-panel-input-text, #ddd); font-size:11px; }
  .history-icon-button { display:inline-flex; align-items:center; justify-content:center; width:27px; min-width:27px; height:27px; padding:0; border:1px solid var(--ui-panel-input-border, #30303a); border-radius:5px; background:var(--ui-tab-bg, #202029); color:var(--ui-connection-text, #999dab); }
  .history-icon-button:hover:not(:disabled) { color:var(--ui-drawer-tab-active, #e4e7ef); border-color:var(--ui-tab-accent, #536b9e); }
  .history-icon-button:disabled { cursor:not-allowed; opacity:.32; }
  .history-icon-danger:hover:not(:disabled) { color:var(--ui-danger, #e06c75); border-color:color-mix(in srgb, var(--ui-danger, #e06c75) 60%, var(--ui-panel-input-border, #30303a)); }
  .history-item { padding:9px 7px; border-bottom:1px solid var(--ui-tabbar-border, #242731); cursor:pointer; border-radius:6px; }
  .history-item:hover { background:color-mix(in srgb, var(--ui-tab-active-bg, #181b24) 80%, transparent); }
  .history-item:active { background:var(--ui-tab-active-bg, #1f2430); }
  .history-item-disabled { cursor:not-allowed; opacity:.55; }
  .history-item-disabled:hover { background:transparent; }
  .history-item:focus-visible { outline:1px solid var(--ui-tab-accent, #536b9e); outline-offset:-1px; }
  .history-item code { display:block; color:var(--ui-history-item-text, #d3d6df); font-size:11px; overflow-wrap:anywhere; }
  .history-item small { display:block; margin:4px 0 7px; color:var(--ui-history-meta, #656a79); font-size:9.5px; }
  .history-item-actions { display:flex; gap:5px; }
  .history-empty { padding:18px; color:#5d6270; font-size:11px; text-align:center; }
  @media (pointer:coarse) { .pinned-command-actions { opacity:.78; } }
  .keybar-scroll { scrollbar-width:none; }
  .keybar-scroll::-webkit-scrollbar { display:none; }
  .tree-filter {
    position: sticky;
    top: 34px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: -1px -1px 7px;
    padding: 7px 8px;
    border-bottom: 1px solid var(--ui-tabbar-border, #25252e);
    background: color-mix(in srgb, var(--ui-tree-bg, #121218) 97%, transparent);
    color: var(--ui-history-meta, #666678);
    backdrop-filter: blur(8px);
  }
  .tree-filter input {
    flex: 1;
    min-width: 0;
    height: 27px;
    border: 1px solid var(--ui-panel-input-border, #30303a);
    border-radius: 6px;
    outline: none;
    padding: 0 8px;
    background: var(--ui-panel-input-bg, #0f0f15);
    color: var(--ui-panel-input-text, #d8d8df);
    font-size: 11px;
  }
  .tree-filter input:focus { border-color: var(--ui-tab-accent, #536b9e); }
  @media (max-width:768px), (pointer:coarse) {
    .pinned-command-editor input, .history-search input, .tree-filter input { font-size:16px; }
    .terminal-screen .xterm-helper-textarea { font-size:16px !important; }
  }
  .tree-filter button {
    width: 25px;
    height: 25px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: var(--ui-tab-bg, #24242d);
    color: var(--ui-connection-text, #9999a6);
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
  .tree-disclosure {
    width: 13px;
    min-width: 13px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ui-history-meta, #777785);
  }
  .tree-entry-icon {
    width: 17px;
    min-width: 17px;
    height: 17px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .tree-folder-icon { color: var(--ui-tab-accent, #7aa2f7); }
  .tree-entry-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tree-spin { animation:tree-spin .8s linear infinite; }
  @keyframes tree-spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .tree-spin { animation:none; } }
  .tree-row[data-selected="1"] { background: color-mix(in srgb, var(--ui-tab-accent, #26304a) 24%, transparent); }
  .tree-error { margin: 2px 8px 6px; padding: 7px 8px; border-left: 2px solid #f7768e; color: #f7768e; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
  .tree-size { margin-left: auto; color: var(--ui-history-meta, #555); font-size: 10px; flex-shrink: 0; }

  /* phone-first: terminal is THE screen */
  .workspace { display: grid !important; grid-template-columns: 1fr; }
  .workspace[hidden] { display:none !important; }
  .tree-col {
    display: flex;
    position: fixed;
    top: var(--vv-top, 0px);
    height: var(--vv-height, 100dvh);
    right: calc(100vw - var(--vv-left, 0px) - var(--vv-width, 100vw));
    width: min(82vw, 320px); z-index: 40;
    transform: translateX(102%); transition: transform .22s ease;
  }
  .tree-col-open { transform: translateX(0); box-shadow: -12px 0 32px rgba(0,0,0,.5); }
  .drawer-mask { position:fixed; top:var(--vv-top, 0px); left:var(--vv-left, 0px); width:var(--vv-width, 100vw); height:var(--vv-height, 100dvh); background:rgba(0,0,0,.45); z-index:39; }
  .preview-col {
    position: fixed;
    top: var(--vv-top, 0px);
    left: var(--vv-left, 0px);
    width: var(--vv-width, 100vw);
    height: var(--vv-height, 100dvh);
    z-index: 50;
    background: var(--ui-term-col-bg, #101014);
  }
  .cwd-hint { max-width: 40vw; }

  @media (min-width: 900px) {
    .workspace.show-tree.has-preview { grid-template-columns: 46% 20% 34%; }
    .workspace.show-tree:not(.has-preview) { grid-template-columns: 80% 20%; }
    .workspace.has-preview:not(.show-tree) { grid-template-columns: 66% 34%; }
    /* desktop: the tree becomes a right column only while the drawer is open */
    .tree-col {
      position: static; top: auto; height: auto; width: auto; transform: none;
      box-shadow: none; border-left: 1px solid var(--ui-tree-border, #1e1e26);
    }
    .workspace:not(.show-tree) .tree-col { display: none; }
    .preview-col { position: relative; inset: auto; width: auto; height: auto; border-left: 1px solid var(--ui-tree-border, #1e1e26); }
    .drawer-mask { display: none; }
  }
  .web-root.is-remote-fullscreen .workspace { grid-template-columns: minmax(0, 1fr); }
`;
