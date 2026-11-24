import { cloneElement, useEffect, useRef, useState, type ReactElement } from "react";
import type { AgentType, AgentWorkspace } from "../../../../shared/src/contracts/agent-api";
import { readAgentWorkspaceCache } from "../../lib/agent-workspace-cache";
import type { ChatViewProps } from "../ChatView";
import HostProjectPicker from "../HostProjectPicker";
import { isWebShell } from "../../web/webLayout";
import { resolveTaskDraftWorkspace, type TaskPaneDraft } from "./session-state";

interface Props {
  draft?: TaskPaneDraft;
  onDraftChange(draft: TaskPaneDraft): void;
  children: ReactElement<ChatViewProps>;
}

/** The same ChatView stays mounted when the first message creates its session. */
export default function TaskPaneConversation({ draft, onDraftChange, children }: Props) {
  const [options, setOptions] = useState<{ agent?: AgentType; data: AgentWorkspace[] }>({ data: [] });
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [hostPicker, setHostPicker] = useState<{ draft: TaskPaneDraft; request: number } | null>(null);
  const latest = useRef(draft);
  const folderRequest = useRef(0);
  latest.current = draft;
  const change = useRef(onDraftChange);
  change.current = onDraftChange;
  const agent = draft?.agentType;
  useEffect(() => () => { folderRequest.current++; }, []);

  useEffect(() => {
    if (!agent) return;
    let disposed = false;
    const initial = latest.current;
    const cached = readAgentWorkspaceCache().agents[agent]?.workspaces ?? [];
    setOptions({ agent, data: cached });
    setError(null);
    void (async () => {
      let cursor: string | null = null;
      const seen = new Set<string>();
      const workspaces = new Map(cached.map(item => [item.workspaceId, item]));
      do {
        const page = await window.agentApi.listAgentWorkspaces(agent, { cursor, limit: 100 });
        if (disposed) return;
        for (const item of page.data) if (item.agentType === agent) workspaces.set(item.workspaceId, item);
        const data = [...workspaces.values()];
        setOptions(previous => ({ agent, data: [...new Map([
          ...(previous.agent === agent ? previous.data : []), ...data,
        ].map(item => [item.workspaceId, item])).values()] }));
        const current = latest.current;
        if (current && initial && current.projectId === initial.projectId && current.cwd === initial.cwd) {
          const selected = resolveTaskDraftWorkspace(current, data, !page.nextCursor);
          if (selected) change.current({ ...current, projectId: selected.workspaceId,
            cwd: selected.roots.includes(current.cwd) ? current.cwd : selected.roots[0] ?? current.cwd, workspaceSource: selected.source });
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("目录分页已失效，请重试");
        if (cursor) seen.add(cursor);
      } while (cursor);
    })().catch(() => { if (!disposed) setError("读取目录失败，请重试或选择其他文件夹"); });
    return () => { disposed = true; };
  }, [agent, reload]);

  const importFolder = async (path: string, current: TaskPaneDraft, request: number) => {
    const isCurrent = () => latest.current?.agentType === current.agentType && folderRequest.current === request;
    if (!isCurrent()) return;
    try {
      const { workspace } = await window.agentApi.importAgentWorkspace(current.agentType, path);
      if (!isCurrent()) return;
      setOptions(previous => ({ agent: current.agentType, data: [workspace,
        ...(previous.agent === current.agentType ? previous.data.filter(item => item.workspaceId !== workspace.workspaceId) : []),
      ] }));
      change.current({ ...current, projectId: workspace.workspaceId, cwd: workspace.roots[0] ?? path, workspaceSource: workspace.source });
    } catch { if (isCurrent()) setError("无法选择目录，请重试"); }
  };
  const pickFolder = async () => {
    const current = latest.current;
    if (!current) return;
    const request = ++folderRequest.current;
    setError(null);
    if (isWebShell()) { setHostPicker({ draft: current, request }); return; }
    try {
      const path = await window.agentApi.openFileDialog();
      if (path) await importFolder(path, current, request);
    } catch { if (folderRequest.current === request) setError("无法选择目录，请重试"); }
  };
  const workspaces = options.agent === agent ? options.data : [];
  const selected = draft?.projectId && !workspaces.some(item => item.workspaceId === draft.projectId)
    ? [{ id: draft.projectId, name: draft.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "当前目录", path: draft.cwd }] : [];

  return <div className="task-pane-conversation">
    {draft && error && <div className="task-pane-workspace-error" role="alert"><span>{error}</span><button type="button" onClick={() => setReload(value => value + 1)}>重试</button></div>}
    {draft ? cloneElement(children, {
      workspaceSource: draft.workspaceSource,
      onSelectAgent: next => {
        folderRequest.current++; setHostPicker(null);
        if (next !== draft.agentType) change.current({ ...draft, agentType: next, projectId: null, workspaceSource: undefined });
      },
      workspaces: [...selected, ...workspaces.map(item => ({ id: item.workspaceId, name: item.name, path: item.roots[0] ?? "", canCreateSession: item.canCreateSession }))],
      onSelectWorkspace: id => {
        folderRequest.current++;
        const workspace = workspaces.find(item => item.workspaceId === id && item.canCreateSession !== false);
        if (workspace) change.current({ ...draft, projectId: id, cwd: workspace.roots[0] ?? "", workspaceSource: workspace.source });
      },
      onPickWorkspaceFolder: () => { void pickFolder(); },
    }) : children}
    {hostPicker && <HostProjectPicker open initialPath={hostPicker.draft.cwd || undefined}
      onCancel={() => { folderRequest.current++; setHostPicker(null); }}
      onConfirm={async path => {
        const selection = hostPicker;
        await importFolder(path, selection.draft, selection.request);
        setHostPicker(current => current === selection ? null : current);
      }} />}
  </div>;
}
