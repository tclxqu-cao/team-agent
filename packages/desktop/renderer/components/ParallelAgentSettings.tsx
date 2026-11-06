import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { AgentType, NativeReasoningEffort, RuntimeModelInfo, UnifiedSessionSummary } from "../global";
import { AGENT_LABELS } from "../lib/agent-catalog";
import { isNativeAgentType, loadNativeRunPref, nativeModelFromKey, nativeModelKey, nativeReasoningEffortOptions, resolveNativeRunPref, saveNativeRunPref, type NativeAgentRunPref } from "../lib/native-agent-run-prefs";
import { useAgentStore } from "../stores/agentStore";
import AgentBrandIcon from "./AgentBrandIcon";
import ContextUsageBar from "./ContextUsageBar";

function NativeSettings({ agentType, onChange }: { agentType: AgentType; onChange: () => void }) {
  const [models, setModels] = useState<RuntimeModelInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(() => loadNativeRunPref(agentType));
  useEffect(() => {
    let cancelled = false;
    setError(""); setLoaded(false);
    void window.agentApi.listAgentModels(agentType).then(result => {
      if (!cancelled) { setModels(result.models ?? []); setLoaded(true); }
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "模型列表加载失败"); });
    return () => { cancelled = true; };
  }, [agentType, revision]);
  const pref = resolveNativeRunPref(saved, models, loaded);
  const selected = pref.model ? models.find(model => nativeModelKey(model) === nativeModelKey(pref.model!)) : undefined;
  const efforts = nativeReasoningEffortOptions(agentType, selected?.reasoningEfforts);
  const change = (patch: NativeAgentRunPref) => {
    const next = { ...pref, ...patch };
    setSaved(next); saveNativeRunPref(agentType, next); onChange();
  };
  return <>
    <label>模型<select aria-label={`${AGENT_LABELS[agentType]} 模型`} value={pref.model ? nativeModelKey(pref.model) : ""}
      disabled={!loaded} onChange={event => change({ model: event.target.value ? nativeModelFromKey(event.target.value, models) : undefined })}>
      <option value="">{loaded ? "默认模型" : "加载中"}</option>
      {models.map(model => <option key={nativeModelKey(model)} value={nativeModelKey(model)}>{model.providerDisplayName ? `${model.providerDisplayName} / ` : ""}{model.displayName || model.id}</option>)}
    </select></label>
    {efforts.length > 0 && <label>思考强度<select aria-label={`${AGENT_LABELS[agentType]} 思考强度`}
      value={pref.reasoningEffort && efforts.includes(pref.reasoningEffort) ? pref.reasoningEffort : ""}
      onChange={event => change({ reasoningEffort: event.target.value ? event.target.value as NativeReasoningEffort : undefined })}>
      <option value="">默认</option>{efforts.map(effort => <option key={effort} value={effort}>{({ low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" })[effort]}</option>)}
    </select></label>}
    {error && <div className="parallel-settings-error" role="alert">{error}<button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
  </>;
}

export default function ParallelAgentSettings({ agentTypes, sessions, onChange, onOpenSession, customerProfiles, customerProfileId, onCustomerProfileChange, customerEffort, contextWindowK }: {
  agentTypes: AgentType[];
  sessions?: UnifiedSessionSummary[];
  onChange: () => void;
  onOpenSession: (session: UnifiedSessionSummary) => void;
  customerProfiles: Array<{ id: string; name: string; modelId: string }>;
  customerProfileId: string;
  onCustomerProfileChange: (id: string) => void;
  customerEffort: { value: "off" | "low" | "medium" | "high"; options: Array<{ value: "off" | "low" | "medium" | "high"; label: string }>; onChange: (value: "off" | "low" | "medium" | "high") => void };
  contextWindowK: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number; maxHeight: number } | null>(null);
  const context = useAgentStore(state => state.contextUsageBySession);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const composerTop = ref.current?.closest(".composer-shell")?.getBoundingClientRect().top ?? anchor.top;
      const menuBottom = Math.max(viewportTop + 16, composerTop - 8);
      const width = Math.max(0, Math.min(320, viewportWidth - 32));
      setPosition({ width,
        left: Math.max(viewportLeft + 16, Math.min(anchor.left, viewportLeft + viewportWidth - width - 16)),
        bottom: window.innerHeight - menuBottom,
        maxHeight: Math.max(0, Math.min(420, menuBottom - viewportTop - 16)) });
    };
    const viewport = window.visualViewport;
    const observer = new ResizeObserver(update);
    if (ref.current) observer.observe(ref.current);
    const composer = ref.current?.closest(".composer-shell");
    if (composer) observer.observe(composer);
    update(); window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    viewport?.addEventListener("resize", update); viewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true);
      viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [open]);
  return <div className="parallel-agent-settings web-native-model-control" ref={ref}>
    <button ref={triggerRef} type="button" className="parallel-agent-settings-trigger" aria-haspopup="dialog" aria-expanded={open}
      aria-label="按 Agent 分别配置模型" onClick={() => setOpen(value => !value)}>分别配置<ChevronDown size={12} /></button>
    {open && position && createPortal(<div ref={menuRef} className="parallel-agent-settings-menu" role="dialog" aria-label="按 Agent 分别配置"
      style={{ position: "fixed", right: "auto", ...position }}>
      {agentTypes.map(agentType => {
        const session = sessions?.find(member => member.agentType === agentType);
        return <section className="parallel-agent-settings-row" key={agentType}>
          <div className="parallel-agent-settings-heading"><AgentBrandIcon agentType={agentType} size={17} />{AGENT_LABELS[agentType]}</div>
          {agentType === "customer-agent" ? <>
            <label>模型<select aria-label="Customer Agent 模型" value={customerProfileId} disabled={!customerProfiles.length}
              onChange={event => onCustomerProfileChange(event.target.value)}>
              {!customerProfiles.length && <option value="">未配置模型</option>}
              {customerProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name || profile.modelId}</option>)}
            </select></label>
            <label>思考强度<select aria-label="Customer Agent 思考强度" value={customerEffort.value}
              onChange={event => customerEffort.onChange(event.target.value as "off" | "low" | "medium" | "high")}>
              {customerEffort.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
          </> : isNativeAgentType(agentType) && session?.nativeModelSelectionSupported !== false
            ? <NativeSettings agentType={agentType} onChange={onChange} />
            : <span>沿用原生模型配置</span>}
          {session && <>
            <ContextUsageBar usage={context[session.id]} contextWindowK={contextWindowK} compact />
            <button type="button" className="parallel-settings-open" onClick={() => { onOpenSession(session); setOpen(false); }}>切换到此 Agent 会话</button>
          </>}
        </section>;
      })}
    </div>, document.body)}
  </div>;
}
