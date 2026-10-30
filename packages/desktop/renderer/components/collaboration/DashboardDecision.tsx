import { useState } from "react";

export default function DashboardDecision({ text, options, recommendation, multiSelect, sourceOnly, onAnswer, onSource }: {
  text: string;
  options?: Array<{ label: string; description: string }>;
  recommendation?: string;
  multiSelect?: boolean;
  sourceOnly?: boolean;
  onAnswer: (text: string, indices?: number[]) => Promise<void>;
  onSource: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [indices, setIndices] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (value: string, selected?: number[]) => {
    if (!value.trim() || busy) return;
    setBusy(true); setError("");
    try { await onAnswer(value, selected); setAnswer(""); }
    catch (error) { setError(error instanceof Error ? error.message : "答复失败，请刷新核对"); }
    finally { setBusy(false); }
  };
  return <section className="session-dashboard-decision" aria-label="待处理决策">
    <p>{text}</p>
    {recommendation && <p className="session-dashboard-recommendation">建议：{recommendation}</p>}
    {!sourceOnly && <>
      <div className="session-dashboard-options">{options?.map((option, index) => multiSelect
        ? <label key={index} title={option.description}><input type="checkbox" checked={indices.includes(index)} disabled={busy} onChange={event => setIndices(old => event.target.checked ? [...old, index] : old.filter(value => value !== index))}/>{option.label}<small>{option.description}</small></label>
        : <button type="button" key={index} disabled={busy} title={option.description} onClick={() => void submit(option.label, [index])}>{option.label}</button>)}</div>
      {multiSelect && !!indices.length && <button type="button" disabled={busy} onClick={() => void submit(indices.map(index => options![index].label).join("、"), indices)}>确认所选</button>}
      <form onSubmit={event => { event.preventDefault(); void submit(answer); }}>
        <input aria-label="答复此决策" value={answer} maxLength={10000} placeholder="输入你的决定" onChange={event => setAnswer(event.target.value)}/>
        <button disabled={busy || !answer.trim()}>{busy ? "处理中…" : "答复"}</button>
      </form>
    </>}
    {error && <p role="alert" className="collab-error">{error}</p>}
    <button type="button" className="session-dashboard-source" onClick={onSource}>{sourceOnly ? "进入原会话填写" : "查看来源会话"}</button>
  </section>;
}
