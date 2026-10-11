"use client";

import { Bot } from "lucide-react";

/** Shared by the module fallback and the embedded page's loading state. */
export default function FlowStudioLoading() {
  return (
    <div className="flow-loading" role="status" aria-live="polite">
      <div className="flow-loader-art" aria-hidden="true">
        <div className="flow-loader-halo" />
        <div className="flow-loader-orbit orbit-outer"><i /></div>
        <div className="flow-loader-orbit orbit-inner"><i /></div>
        <div className="flow-loader-core"><Bot size={36} strokeWidth={1.5} /></div>
        <span className="flow-loader-node node-one" />
        <span className="flow-loader-node node-two" />
        <span className="flow-loader-node node-three" />
      </div>
      <div className="flow-loader-copy">
        <span className="flow-loader-label">FLOW STUDIO</span>
        <strong>正在打开 Flow Studio</strong>
        <span className="flow-loader-caption">即将进入你的创作空间</span>
      </div>
      <div className="flow-loader-track" aria-hidden="true"><span /></div>
      <style jsx>{`
        .flow-loading { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; overflow:hidden; gap:26px; color:var(--ui-text, #e5e7eb); background:var(--ui-term-col-bg, #101014); animation:flow-appear 280ms ease-out both; }
        .flow-loader-art { position:relative; width:200px; height:200px; flex-shrink:0; }
        .flow-loader-halo { position:absolute; inset:-40px; border-radius:50%; background:radial-gradient(circle, #54e5cf26, #54e5cf08 45%, transparent 70%); animation:flow-breathe 3s ease-in-out infinite; }
        .flow-loader-orbit { position:absolute; border-radius:50%; border:1px solid #54e5cf26; }
        .orbit-outer { inset:8px; border-top-color:#54e5cf; border-right-color:#54e5cf70; animation:flow-orbit 3.2s linear infinite; }
        .orbit-inner { inset:30px; border-bottom-color:#8bbcff; border-left-color:#8bbcff60; animation:flow-orbit 2.4s linear infinite reverse; }
        .flow-loader-orbit i { position:absolute; top:13%; left:13%; width:7px; height:7px; border-radius:50%; background:#77f8df; box-shadow:0 0 14px #54e5cf; }
        .orbit-inner i { background:#8bbcff; box-shadow:0 0 14px #8bbcff; }
        .flow-loader-core { position:absolute; inset:62px; display:grid; place-items:center; border-radius:24px; color:#64e9d3; border:1px solid #54e5cf66; background:linear-gradient(145deg, #54e5cf20, #8bbcff0d); box-shadow:0 0 35px #54e5cf15, inset 0 0 18px #54e5cf0d; animation:flow-breathe 3s ease-in-out infinite; }
        .flow-loader-node { position:absolute; width:5px; height:5px; border-radius:50%; background:#8bbcff; animation:flow-node 2s ease-in-out infinite; }
        .node-one { left:0; top:100px; } .node-two { right:17px; top:38px; animation-delay:.5s; } .node-three { bottom:9px; right:57px; animation-delay:1s; }
        .flow-loader-copy { display:flex; flex-direction:column; align-items:center; gap:10px; text-align:center; padding:0 20px; }
        .flow-loader-label { font:10px ui-monospace, monospace; letter-spacing:.3em; color:#64cbbb; }
        .flow-loader-copy strong { font-size:18px; font-weight:500; letter-spacing:.02em; }
        .flow-loader-caption { font-size:12px; color:var(--ui-text-muted, #9399aa); }
        .flow-loader-track { width:128px; height:2px; overflow:hidden; background:#54e5cf20; border-radius:2px; }
        .flow-loader-track span { display:block; width:45%; height:100%; background:linear-gradient(90deg, transparent, #64e9d3, #8bbcff); animation:flow-travel 1.8s ease-in-out infinite; }
        @keyframes flow-orbit { to { transform:rotate(360deg); } }
        @keyframes flow-breathe { 50% { transform:scale(1.05); opacity:.7; } }
        @keyframes flow-node { 50% { opacity:.25; transform:scale(.65); } }
        @keyframes flow-travel { from { transform:translateX(-110%); } to { transform:translateX(330%); } }
        @keyframes flow-appear { from { opacity:0; } to { opacity:1; } }
        @media (max-height:420px) { .flow-loading { gap:12px; } .flow-loader-art { width:200px; height:200px; zoom:.65; } }
        @media (prefers-reduced-motion:reduce) { .flow-loading, .flow-loader-halo, .flow-loader-orbit, .flow-loader-core, .flow-loader-node, .flow-loader-track span { animation:none; } }
      `}</style>
    </div>
  );
}
