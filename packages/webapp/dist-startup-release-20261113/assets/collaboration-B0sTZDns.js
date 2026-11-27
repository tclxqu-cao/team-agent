import{c as t}from"./index-B_qrzBSm.js";/**
 * @license lucide-react v0.468.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const d=t("Users",[["path",{d:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",key:"1yyitq"}],["circle",{cx:"9",cy:"7",r:"4",key:"nufk8"}],["path",{d:"M22 21v-2a4 4 0 0 0-3-3.87",key:"kshegd"}],["path",{d:"M16 3.13a4 4 0 0 1 0 7.75",key:"1da9ce"}]]);async function n(o){var e;if(!((e=window.agentApi)!=null&&e.collaboration))throw new Error("当前服务不支持协作群，请连接更新后的服务");return await window.agentApi.collaboration(o)}const r={"customer-agent":"Customer Agent",codex:"Codex","claude-code":"Claude Code",opencode:"OpenCode","deepseek-harness":"DeepSeek Harness",qoder:"Qoder",zcode:"ZCode",workbuddy:"WorkBuddy",copilot:"VS Code Copilot"},c={idle:"未开始",running:"协作中",waiting:"等待你",stopping:"正在停止",stopped:"已停止",completed:"已完成",interrupted:"已中断"};export{r as A,c as D,d as U,n as c};
