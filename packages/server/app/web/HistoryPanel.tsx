"use client";
import { useCallback, useEffect, useState } from "react";

interface HistoryItem { id:number; terminalId:string; command:string; cwd:string; executedAt:string }
export default function HistoryPanel({csrfToken,terminalId,onFill}:{csrfToken:string;terminalId:string|null;onFill:(command:string)=>void}){
  const [items,setItems]=useState<HistoryItem[]>([]); const [query,setQuery]=useState("");
  const load=useCallback(async()=>{const params=new URLSearchParams({q:query,limit:"200"});const response=await fetch(`/api/web-console/history?${params}`,{credentials:"same-origin"});if(response.ok)setItems((await response.json()).history);},[query]);
  useEffect(()=>{const timer=setTimeout(load,200);return()=>clearTimeout(timer);},[load]);
  const remove=async(id:number)=>{await fetch("/api/web-console/history",{method:"DELETE",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrfToken},body:JSON.stringify({id})});load();};
  const fill=(command:string)=>{if(!terminalId)return;onFill(command);};
  return <div className="history-panel"><div className="history-search"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索命令"/><button onClick={load}>刷新</button></div>{items.map(item=><div className={`history-item${terminalId?"":" history-item-disabled"}`} key={item.id} role="button" tabIndex={terminalId?0:-1} onClick={()=>fill(item.command)} onKeyDown={(event)=>{if((event.key==="Enter"||event.key===" ")&&terminalId){event.preventDefault();fill(item.command);}}}><code>{item.command}</code><small>{item.cwd} · {new Date(item.executedAt).toLocaleString()}</small><div className="history-item-actions" onClick={(event)=>event.stopPropagation()} onPointerDown={(event)=>event.stopPropagation()}><button onClick={()=>navigator.clipboard.writeText(item.command)}>复制</button><button disabled={!terminalId} onClick={()=>fill(item.command)}>填入</button><button onClick={()=>remove(item.id)}>删除</button></div></div>)}{!items.length&&<div className="history-empty">暂无 Shell 命令历史</div>}{!terminalId&&!!items.length&&<div className="history-empty">请先打开一个终端页签</div>}</div>;
}
