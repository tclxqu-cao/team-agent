import { useState, useMemo, useEffect } from "react";

export interface ToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

interface ToolCallProps {
  toolCall: ToolCallData;
  onSelectSession?: (sessionId: string) => void;
  /** For write_file: content BEFORE the write (from a preceding read_file) — enables diff view */
  beforeContent?: string;
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

function lineCount(s: string): number {
  return s ? s.split("\n").length : 0;
}

type DiffLine = { type: "added" | "removed" | "same"; text: string; lineNo: number };

function computeDiff(before: string, after: string): DiffLine[] {
  const bl = before.split("\n");
  const al = after.split("\n");
  if (bl.length * al.length > 200_000) {
    return al.map((text, i) => ({ type: "added" as const, text, lineNo: i + 1 }));
  }
  const m = bl.length, n = al.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = bl[i-1] === al[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  const lcs: Array<[number,number]> = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (bl[i-1] === al[j-1]) { lcs.unshift([i-1, j-1]); i--; j--; }
    else if (dp[i-1][j] >= dp[i][j-1]) i--;
    else j--;
  }
  const result: DiffLine[] = [];
  let bi = 0, ai = 0;
  for (const [bIdx, aIdx] of lcs) {
    while (bi < bIdx) { result.push({ type: "removed", text: bl[bi], lineNo: bi+1 }); bi++; }
    while (ai < aIdx) { result.push({ type: "added", text: al[ai], lineNo: ai+1 }); ai++; }
    result.push({ type: "same", text: bl[bi], lineNo: bi+1 });
    bi++; ai++;
  }
  while (bi < m) { result.push({ type: "removed", text: bl[bi], lineNo: bi+1 }); bi++; }
  while (ai < n) { result.push({ type: "added", text: al[ai], lineNo: ai+1 }); ai++; }
  return result;
}

function CodeBlock({ content, maxHeight = 320 }: { content: string; maxHeight?: number }) {
  const lines = content.split("\n");
  return (
    <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border-subtle)", borderRadius:8, overflow:"auto", maxHeight, fontFamily:"var(--font-mono)", fontSize:11, lineHeight:1.65 }}>
      <table style={{ borderCollapse:"collapse", width:"100%", tableLayout:"fixed" }}>
        <colgroup><col style={{ width:40 }}/><col/></colgroup>
        <tbody>
          {lines.map((line, idx) => (
            <tr key={idx}>
              <td style={{ padding:"0 8px", color:"var(--text-muted)", textAlign:"right", userSelect:"none", borderRight:"1px solid var(--border-subtle)", background:"var(--bg-deep)", fontSize:10, minWidth:36 }}>{idx+1}</td>
              <td style={{ padding:"0 12px", color:"var(--text-secondary)", wordBreak:"break-all", whiteSpace:"pre-wrap" }}>{line||" "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffBlock({ diff, maxHeight = 360 }: { diff: DiffLine[]; maxHeight?: number }) {
  const changed = diff.filter(d => d.type !== "same");
  if (changed.length === 0) return <div style={{ fontSize:11, color:"var(--text-muted)", padding:"10px 12px", fontFamily:"var(--font-mono)" }}>内容未变化</div>;
  const changedIdxs = new Set(diff.map((d,i) => d.type!=="same"?i:-1).filter(i=>i>=0));
  const visible = new Set<number>();
  changedIdxs.forEach(ci => { for (let k=Math.max(0,ci-3);k<=Math.min(diff.length-1,ci+3);k++) visible.add(k); });
  const rows: Array<{diffLine:DiffLine;diffIdx:number}|"ellipsis"> = [];
  let last = -1;
  [...visible].sort((a,b)=>a-b).forEach(idx => {
    if (last>=0 && idx>last+1) rows.push("ellipsis");
    rows.push({diffLine:diff[idx],diffIdx:idx});
    last=idx;
  });
  return (
    <div style={{ background:"var(--bg-surface)", border:"1px solid var(--border-subtle)", borderRadius:8, overflow:"auto", maxHeight, fontFamily:"var(--font-mono)", fontSize:11, lineHeight:1.65 }}>
      <table style={{ borderCollapse:"collapse", width:"100%", tableLayout:"fixed" }}>
        <colgroup><col style={{ width:24 }}/><col style={{ width:36 }}/><col/></colgroup>
        <tbody>
          {rows.map((row,i) => {
            if (row==="ellipsis") return <tr key={`e${i}`}><td colSpan={3} style={{ padding:"2px 12px", color:"var(--text-muted)", fontSize:10, background:"var(--bg-deep)", textAlign:"center" }}>⋯</td></tr>;
            const {diffLine} = row;
            const bg = diffLine.type==="added"?"rgba(5,150,105,0.08)":diffLine.type==="removed"?"rgba(220,38,38,0.07)":"transparent";
            const prefix = diffLine.type==="added"?"+":diffLine.type==="removed"?"−":" ";
            const prefixColor = diffLine.type==="added"?"var(--success)":diffLine.type==="removed"?"var(--danger)":"transparent";
            const textColor = diffLine.type==="added"?"#059669":diffLine.type==="removed"?"var(--danger)":"var(--text-secondary)";
            return (
              <tr key={i} style={{ background:bg }}>
                <td style={{ padding:"0 4px", textAlign:"center", color:prefixColor, fontWeight:700, userSelect:"none" }}>{prefix}</td>
                <td style={{ padding:"0 6px", color:"var(--text-muted)", textAlign:"right", fontSize:10, borderRight:"1px solid var(--border-subtle)", userSelect:"none" }}>{diffLine.lineNo}</td>
                <td style={{ padding:"0 12px", color:textColor, wordBreak:"break-all", whiteSpace:"pre-wrap" }}>{diffLine.text||" "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WriteFileCard({ toolCall, beforeContent }: { toolCall: ToolCallData; beforeContent?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"content"|"diff">("content");
  const filePath = (toolCall.arguments.file_path as string)??"";
  const content = (toolCall.arguments.content as string)??"";
  const lines = lineCount(content);
  const isError = toolCall.isError;
  const isDone = !!toolCall.result;
  const statusColor = isDone?(isError?"var(--danger)":"var(--success)"):"var(--accent)";
  const statusBg = isDone?(isError?"rgba(220,38,38,0.07)":"rgba(5,150,105,0.07)"):"var(--accent-dim)";
  const borderColor = isDone?(isError?"rgba(220,38,38,0.18)":"rgba(5,150,105,0.18)"):"var(--border-default)";
  const diff = useMemo(() => beforeContent&&content ? computeDiff(beforeContent,content) : null, [beforeContent,content]);
  const diffStats = useMemo(() => {
    if (!diff) return null;
    return { added: diff.filter(d=>d.type==="added").length, removed: diff.filter(d=>d.type==="removed").length };
  }, [diff]);
  return (
    <div style={{ marginTop:10, borderRadius:10, border:`1px solid ${borderColor}`, overflow:"hidden", fontSize:12, background:"var(--bg-deepest)", transition:"border-color 0.25s" }}>
      <button onClick={()=>setExpanded(!expanded)} style={{ width:"100%", padding:"9px 12px", background:statusBg, border:"none", cursor:"pointer", textAlign:"left", display:"flex", justifyContent:"space-between", alignItems:"center", fontFamily:"var(--font-body)", transition:"filter 0.15s" }} onMouseEnter={e=>{e.currentTarget.style.filter="brightness(0.96)"}} onMouseLeave={e=>{e.currentTarget.style.filter="brightness(1)"}}>
        <span style={{ display:"flex", alignItems:"center", gap:8, minWidth:0 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span style={{ fontFamily:"var(--font-mono)", fontSize:11.5, color:statusColor, fontWeight:600, letterSpacing:"0.01em", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:220 }} title={filePath}>{basename(filePath)}</span>
          <span style={{ fontSize:10, padding:"1px 7px", borderRadius:20, background:"rgba(79,110,247,0.1)", color:"var(--accent)", fontWeight:500, flexShrink:0 }}>{lines} 行</span>
          {diffStats&&(<span style={{ fontSize:10, color:"var(--text-muted)", flexShrink:0, display:"flex", gap:4 }}>{diffStats.added>0&&<span style={{ color:"var(--success)" }}>+{diffStats.added}</span>}{diffStats.removed>0&&<span style={{ color:"var(--danger)" }}>−{diffStats.removed}</span>}</span>)}
          <span style={{ fontSize:10, padding:"1px 7px", borderRadius:20, background:statusBg, color:statusColor, fontWeight:500, flexShrink:0 }}>{isDone?(isError?"错误":"已写入"):"写入中"}</span>
        </span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" style={{ transition:"transform 0.3s var(--ease-out)", transform:expanded?"rotate(180deg)":"rotate(0deg)", flexShrink:0 }}><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div style={{ overflow:"hidden", maxHeight:expanded?600:0, opacity:expanded?1:0, transition:"max-height 0.4s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease" }}>
        <div style={{ padding:"10px 12px", borderTop:`1px solid ${borderColor}`, display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontSize:10, color:"var(--text-muted)", fontFamily:"var(--font-mono)", wordBreak:"break-all" }}>{filePath}</div>
          {diff&&(<div style={{ display:"flex", gap:4, borderBottom:"1px solid var(--border-subtle)", paddingBottom:6 }}>{(["content","diff"] as const).map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{ padding:"3px 10px", borderRadius:5, border:"none", cursor:"pointer", fontSize:11, fontWeight:500, background:tab===t?"var(--accent-dim)":"transparent", color:tab===t?"var(--accent)":"var(--text-muted)", transition:"background 0.15s" }}>{t==="content"?"文件内容":"变更行"}</button>
          ))}</div>)}
          {tab==="diff"&&diff ? <DiffBlock diff={diff}/> : <CodeBlock content={content}/>}
          {isError&&toolCall.result&&(<div style={{ fontSize:11, color:"var(--danger)", fontFamily:"var(--font-mono)", padding:"8px 12px", background:"rgba(220,38,38,0.04)", border:"1px solid rgba(220,38,38,0.15)", borderRadius:7 }}>{toolCall.result}</div>)}
        </div>
      </div>
    </div>
  );
}

function ReadFileCard({ toolCall }: { toolCall: ToolCallData }) {
  const [expanded, setExpanded] = useState(false);
  const filePath = (toolCall.arguments.file_path as string)??"";
  const offset = toolCall.arguments.offset as number|undefined;
  const limit = toolCall.arguments.limit as number|undefined;
  const resultContent = toolCall.result??"";
  const lines = lineCount(resultContent);
  const isError = toolCall.isError;
  const isDone = !!toolCall.result;
  const statusColor = isDone?(isError?"var(--danger)":"var(--success)"):"var(--accent)";
  const statusBg = isDone?(isError?"rgba(220,38,38,0.07)":"rgba(5,150,105,0.07)"):"var(--accent-dim)";
  const borderColor = isDone?(isError?"rgba(220,38,38,0.18)":"rgba(5,150,105,0.18)"):"var(--border-default)";
  const rangeLabel = offset!==undefined?`第${offset}行起`+(limit?` ×${limit}`:""):null;
  return (
    <div style={{ marginTop:10, borderRadius:10, border:`1px solid ${borderColor}`, overflow:"hidden", fontSize:12, background:"var(--bg-deepest)", transition:"border-color 0.25s" }}>
      <button onClick={()=>setExpanded(!expanded)} style={{ width:"100%", padding:"9px 12px", background:statusBg, border:"none", cursor:"pointer", textAlign:"left", display:"flex", justifyContent:"space-between", alignItems:"center", fontFamily:"var(--font-body)", transition:"filter 0.15s" }} onMouseEnter={e=>{e.currentTarget.style.filter="brightness(0.96)"}} onMouseLeave={e=>{e.currentTarget.style.filter="brightness(1)"}}>
        <span style={{ display:"flex", alignItems:"center", gap:8, minWidth:0 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          <span style={{ fontFamily:"var(--font-mono)", fontSize:11.5, color:statusColor, fontWeight:600, letterSpacing:"0.01em", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:230 }} title={filePath}>{basename(filePath)}</span>
          {rangeLabel&&<span style={{ fontSize:10, padding:"1px 7px", borderRadius:20, background:"rgba(79,110,247,0.1)", color:"var(--accent)", fontWeight:500, flexShrink:0 }}>{rangeLabel}</span>}
          {isDone&&!isError&&<span style={{ fontSize:10, padding:"1px 7px", borderRadius:20, background:"rgba(79,110,247,0.1)", color:"var(--accent)", fontWeight:500, flexShrink:0 }}>{lines} 行</span>}
          <span style={{ fontSize:10, padding:"1px 7px", borderRadius:20, background:statusBg, color:statusColor, fontWeight:500, flexShrink:0 }}>{isDone?(isError?"错误":"已读取"):"读取中"}</span>
        </span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" style={{ transition:"transform 0.3s var(--ease-out)", transform:expanded?"rotate(180deg)":"rotate(0deg)", flexShrink:0 }}><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div style={{ overflow:"hidden", maxHeight:expanded?500:0, opacity:expanded?1:0, transition:"max-height 0.4s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease" }}>
        <div style={{ padding:"10px 12px", borderTop:`1px solid ${borderColor}`, display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontSize:10, color:"var(--text-muted)", fontFamily:"var(--font-mono)", wordBreak:"break-all" }}>{filePath}</div>
          {isDone&&!isError?<CodeBlock content={resultContent}/>:isDone&&isError&&<div style={{ fontSize:11, color:"var(--danger)", fontFamily:"var(--font-mono)", padding:"8px 12px", background:"rgba(220,38,38,0.04)", border:"1px solid rgba(220,38,38,0.15)", borderRadius:7 }}>{resultContent}</div>}
        </div>
      </div>
    </div>
  );
}

function GenericToolCard({ toolCall, onSelectSession }: { toolCall: ToolCallData; onSelectSession?: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const isDispatch = toolCall.name==="dispatch_agent";
  const subAgentStatus = toolCall.arguments.subAgentStatus as "completed"|"failed"|undefined;
  const subAgentDetail = toolCall.arguments.subAgentDetail as string|undefined;
  const subAgentProgress = toolCall.arguments.subAgentProgress as string|undefined;

  // Auto-expand dispatch card when streaming progress arrives
  useEffect(() => {
    if (isDispatch && !subAgentStatus && subAgentProgress) {
      setExpanded(true);
    }
  }, [isDispatch, subAgentStatus, subAgentProgress]);
  const statusColor = isDispatch ? (subAgentStatus==="failed"?"var(--danger)":subAgentStatus==="completed"?"var(--success)":"var(--accent)") : (toolCall.result?(toolCall.isError?"var(--danger)":"var(--success)"):"var(--accent)");
  const statusBg = isDispatch ? (subAgentStatus==="failed"?"rgba(220,38,38,0.07)":subAgentStatus==="completed"?"rgba(5,150,105,0.07)":"var(--accent-dim)") : (toolCall.result?(toolCall.isError?"rgba(220,38,38,0.07)":"rgba(5,150,105,0.07)"):"var(--accent-dim)");
  const borderColor = isDispatch ? (subAgentStatus==="failed"?"rgba(220,38,38,0.18)":subAgentStatus==="completed"?"rgba(5,150,105,0.18)":"var(--border-default)") : (toolCall.result?(toolCall.isError?"rgba(220,38,38,0.18)":"rgba(5,150,105,0.18)"):"var(--border-default)");
  const badgeLabel = isDispatch ? (subAgentStatus==="failed"?"失败":subAgentStatus==="completed"?"已完成":"运行中") : (toolCall.result?(toolCall.isError?"错误":"完成"):"执行中");
  return (
    <div style={{ marginTop:10, borderRadius:10, border:`1px solid ${borderColor}`, overflow:"hidden", fontSize:12, background:"var(--bg-deepest)", transition:"border-color 0.25s" }}>
      <button onClick={()=>setExpanded(!expanded)} style={{ width:"100%", padding:"9px 12px", background:statusBg, border:"none", cursor:"pointer", textAlign:"left", display:"flex", justifyContent:"space-between", alignItems:"center", fontFamily:"var(--font-body)", transition:"filter 0.15s" }} onMouseEnter={e=>{e.currentTarget.style.filter="brightness(0.96)"}} onMouseLeave={e=>{e.currentTarget.style.filter="brightness(1)"}}>
        <span style={{ display:"flex", alignItems:"center", gap:8 }}>
          {isDispatch?(<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a5 5 0 1 0 0 10A5 5 0 0 0 12 2z"/><path d="M12 12c-5.33 0-8 2.67-8 4v2h16v-2c0-1.33-2.67-4-8-4z"/></svg>):(<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>)}
          <span style={{ fontFamily:"var(--font-mono)", fontSize:11.5, color:statusColor, fontWeight:600, letterSpacing:"0.01em" }}>{isDispatch?`@${toolCall.arguments.agentName as string??toolCall.name}`:toolCall.name}</span>
          <span style={{ fontSize:10, padding:"1px 7px", borderRadius:20, background:statusBg, color:statusColor, fontWeight:500 }}>{badgeLabel}</span>
          {isDispatch&&toolCall.arguments.task&&<span style={{ fontSize:11, color:"var(--text-muted)", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{toolCall.arguments.task as string}</span>}
        </span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" style={{ transition:"transform 0.3s var(--ease-out)", transform:expanded?"rotate(180deg)":"rotate(0deg)", flexShrink:0 }}><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div style={{ overflow:"hidden", maxHeight:expanded?800:0, opacity:expanded?1:0, transition:"max-height 0.4s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease" }}>
        <div style={{ padding:"12px 14px", borderTop:`1px solid ${borderColor}`, display:"flex", flexDirection:"column", gap:10 }}>
          <div>
            <div style={{ fontSize:10, color:"var(--text-muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:6 }}>参数</div>
            <pre style={{ fontSize:11, color:"var(--text-secondary)", whiteSpace:"pre-wrap", wordBreak:"break-all", fontFamily:"var(--font-mono)", padding:"10px 12px", borderRadius:8, background:"var(--bg-surface)", border:"1px solid var(--border-subtle)", margin:0, lineHeight:1.6 }}>{JSON.stringify(toolCall.arguments, null, 2)}</pre>
          </div>
          {toolCall.result&&(<div>
            <div style={{ fontSize:10, color:"var(--text-muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:6 }}>{toolCall.isError?"错误信息":"返回结果"}</div>
            <pre style={{ fontSize:11, color:toolCall.isError?"var(--danger)":"var(--text-secondary)", whiteSpace:"pre-wrap", wordBreak:"break-all", fontFamily:"var(--font-mono)", padding:"10px 12px", borderRadius:8, background:toolCall.isError?"rgba(220,38,38,0.04)":"var(--bg-surface)", border:`1px solid ${toolCall.isError?"rgba(220,38,38,0.15)":"var(--border-subtle)"}`, borderLeft:`3px solid ${toolCall.isError?"var(--danger)":"var(--success)"}`, maxHeight:240, overflow:"auto", margin:0, lineHeight:1.6 }}>{toolCall.result}</pre>
          </div>)}
          {isDispatch&&subAgentStatus&&subAgentDetail&&(<div>
            <div style={{ fontSize:10, color:"var(--text-muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:6 }}>{subAgentStatus==="failed"?"错误信息":"执行摘要"}</div>
            <pre style={{ fontSize:11, color:subAgentStatus==="failed"?"var(--danger)":"var(--text-secondary)", whiteSpace:"pre-wrap", wordBreak:"break-all", fontFamily:"var(--font-mono)", padding:"10px 12px", borderRadius:8, background:subAgentStatus==="failed"?"rgba(220,38,38,0.04)":"var(--bg-surface)", border:`1px solid ${subAgentStatus==="failed"?"rgba(220,38,38,0.15)":"var(--border-subtle)"}`, borderLeft:`3px solid ${subAgentStatus==="failed"?"var(--danger)":"var(--success)"}`, maxHeight:180, overflow:"auto", margin:0, lineHeight:1.6 }}>{subAgentDetail}</pre>
          </div>)}
          {isDispatch&&!subAgentStatus&&subAgentProgress&&(<div>
            <div style={{ fontSize:10, color:"var(--text-muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:6 }}>实时输出</div>
            <pre style={{ fontSize:11, color:"var(--text-secondary)", whiteSpace:"pre-wrap", wordBreak:"break-all", fontFamily:"var(--font-mono)", padding:"10px 12px", borderRadius:8, background:"var(--bg-surface)", border:"1px solid var(--border-subtle)", borderLeft:"3px solid var(--accent)", maxHeight:240, overflow:"auto", margin:0, lineHeight:1.6 }}>{subAgentProgress}<span style={{ display:"inline-block", width:"0.55em", height:"1em", background:"var(--accent)", verticalAlign:"text-bottom", animation:"blink 1s step-end infinite" }}>&#8203;</span></pre>
          </div>)}
          {isDispatch&&toolCall.arguments.subSessionId&&onSelectSession&&(
            <button onClick={()=>onSelectSession(toolCall.arguments.subSessionId as string)} style={{ alignSelf:"flex-start", padding:"5px 10px", borderRadius:6, border:"1px solid var(--border-default)", background:"var(--accent-dim)", color:"var(--accent)", fontSize:11, fontWeight:500, cursor:"pointer", display:"flex", alignItems:"center", gap:5, transition:"background 0.15s" }} onMouseEnter={e=>{(e.currentTarget as HTMLButtonElement).style.background="var(--accent)";(e.currentTarget as HTMLButtonElement).style.color="white"}} onMouseLeave={e=>{(e.currentTarget as HTMLButtonElement).style.background="var(--accent-dim)";(e.currentTarget as HTMLButtonElement).style.color="var(--accent)"}}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a5 5 0 1 0 0 10A5 5 0 0 0 12 2z"/><path d="M12 12c-5.33 0-8 2.67-8 4v2h16v-2c0-1.33-2.67-4-8-4z"/></svg>
              查看子会话
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ToolCallCard({ toolCall, onSelectSession, beforeContent }: ToolCallProps) {
  if (toolCall.name==="write_file") return <WriteFileCard toolCall={toolCall} beforeContent={beforeContent}/>;
  if (toolCall.name==="read_file") return <ReadFileCard toolCall={toolCall}/>;
  return <GenericToolCard toolCall={toolCall} onSelectSession={onSelectSession}/>;
}
