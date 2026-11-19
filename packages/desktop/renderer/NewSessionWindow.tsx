import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { RuntimeHealth, UnifiedSessionSummary } from "./global";
import ChatView from "./components/ChatView";
import TaskPaneConversation from "./components/desktop-task-split/TaskPaneConversation";
import type { TaskPaneDraft } from "./components/desktop-task-split/session-state";
import { readNewSessionWindow } from "./lib/new-session-window";
import { createAgentStore } from "./stores/agentStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useUIStore } from "./stores/uiStore";
import "./styles/new-session-window.css";

/** A separate renderer owns its draft and session without restoring the main workspace. */
export default function NewSessionWindow() {
  const [store] = useState(() => createAgentStore());
  const [draft, setDraft] = useState<TaskPaneDraft>(() => {
    const options = readNewSessionWindow(window.location.search);
    return { agentType: options?.agentType ?? "customer-agent", projectId: null, cwd: options?.workspacePath ?? "" };
  });
  const [session, setSession] = useState<UnifiedSessionSummary | null>(null);
  const [health, setHealth] = useState<RuntimeHealth[]>([]);
  const [error, setError] = useState("");
  const skin = useUIStore(state => state.skin);

  useEffect(() => { document.documentElement.setAttribute("data-skin", skin); }, [skin]);
  useEffect(() => { document.title = session?.title ? `${session.title} · AgentRoam` : "新建会话 · AgentRoam"; }, [session?.title]);
  useEffect(() => {
    let active = true;
    void useSettingsStore.getState().loadFromSystem();
    void window.agentApi.getRuntimeHealth().then(value => { if (active) setHealth(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const selectSession = async (id: string, receipt?: UnifiedSessionSummary) => {
    if (receipt) { setSession(receipt); return; }
    try {
      const detail = await window.agentApi.getSession(id, { limit: 1, view: "core" });
      setSession(detail as UnifiedSessionSummary);
      setError("");
    } catch { setError("无法打开会话，请重试"); }
  };

  return <main className="new-session-window" aria-label="会话小窗">
    {error && <div className="new-session-window-error" role="alert">{error}</div>}
    <TaskPaneConversation draft={session ? undefined : draft} onDraftChange={setDraft}>
      <ChatView agentStore={store} desktopTaskPane
        activeAgentType={session?.agentType ?? draft.agentType}
        selectedProjectId={session?.projectId ?? draft.projectId}
        selectedSessionId={session?.id ?? null}
        sessionSummary={session ?? undefined} sessionTitle={session?.title ?? "新建会话"}
        paneControls={<button type="button" className="ui-icon-button new-session-window-close"
          aria-label="关闭会话小窗" title="关闭会话小窗" onClick={() => window.close()}>
          <X size={17} aria-hidden="true" />
        </button>}
        workspacePath={session?.cwd ?? draft.cwd} runtimeHealth={health} focusComposerNonce={1}
        sessionCreationPending={!session && !draft.projectId}
        onSessionCreated={(id, receipt) => selectSession(id, receipt)}
        onSelectSession={(id, receipt) => { void selectSession(id, receipt); }}
        onParallelSessionSelected={receipt => { setSession(receipt); }}
      />
    </TaskPaneConversation>
  </main>;
}
