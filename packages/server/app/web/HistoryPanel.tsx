"use client";
import { useCallback, useEffect, useState } from "react";
import type { PinnedCommand } from "@agent/core";
import { Copy, Pin, RefreshCw, TextCursorInput, Trash2 } from "lucide-react";
import PinnedCommandList from "./PinnedCommandList";

interface HistoryItem { id:number; terminalId:string; command:string; cwd:string; executedAt:string }
export default function HistoryPanel({csrfToken,terminalId,pinnedCommands,onPinnedCommandsChange,onFill,onExecute}:{csrfToken:string;terminalId:string|null;pinnedCommands:PinnedCommand[];onPinnedCommandsChange:(commands:PinnedCommand[])=>void;onFill:(command:string)=>void;onExecute:(command:string)=>void}){
  const [items,setItems]=useState<HistoryItem[]>([]); const [query,setQuery]=useState("");
  const load=useCallback(async()=>{const params=new URLSearchParams({q:query,limit:"200"});const response=await fetch(`/api/web-console/history?${params}`,{credentials:"same-origin"});if(response.ok)setItems((await response.json()).history);},[query]);
  useEffect(()=>{const timer=setTimeout(load,200);return()=>clearTimeout(timer);},[load]);
  const remove=async(id:number)=>{await fetch("/api/web-console/history",{method:"DELETE",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrfToken},body:JSON.stringify({id})});load();};
  const fill=(command:string)=>{if(!terminalId)return;onFill(command);};
  const pin=useCallback((command:string)=>{if(command==="[REDACTED]"||pinnedCommands.some(item=>item.command===command))return;onPinnedCommandsChange([...pinnedCommands,{id:crypto.randomUUID(),command}]);},[onPinnedCommandsChange,pinnedCommands]);
  return <div className="history-panel">
    <PinnedCommandList commands={pinnedCommands} onChange={onPinnedCommandsChange} onExecute={onExecute}/>
    <div className="history-search"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索命令"/><button className="history-icon-button" onClick={load} aria-label="刷新历史" title="刷新历史"><RefreshCw size={13} aria-hidden="true"/></button></div>
    {items.map(item=><div className={`history-item${terminalId?"":" history-item-disabled"}`} key={item.id} role="button" tabIndex={terminalId?0:-1} onClick={()=>fill(item.command)} onKeyDown={(event)=>{if((event.key==="Enter"||event.key===" ")&&terminalId){event.preventDefault();fill(item.command);}}}><code>{item.command}</code><small>{item.cwd} · {new Date(item.executedAt).toLocaleString()}</small><div className="history-item-actions" onClick={(event)=>event.stopPropagation()} onPointerDown={(event)=>event.stopPropagation()}>
      <button className="history-icon-button" onClick={()=>navigator.clipboard.writeText(item.command)} aria-label="复制命令" title="复制"><Copy size={12} aria-hidden="true"/></button>
      <button className="history-icon-button" disabled={!terminalId} onClick={()=>fill(item.command)} aria-label="填入命令" title="填入"><TextCursorInput size={12} aria-hidden="true"/></button>
      <button className="history-icon-button" disabled={item.command==="[REDACTED]"||pinnedCommands.some(command=>command.command===item.command)} onClick={()=>pin(item.command)} aria-label="置顶命令" title="置顶"><Pin size={12} aria-hidden="true"/></button>
      <button className="history-icon-button history-icon-danger" onClick={()=>remove(item.id)} aria-label="删除历史" title="删除"><Trash2 size={12} aria-hidden="true"/></button>
    </div></div>)}
    {!items.length&&<div className="history-empty">暂无 Shell 命令历史</div>}{!terminalId&&!!items.length&&<div className="history-empty">请先打开一个终端页签</div>}
  </div>;
}
