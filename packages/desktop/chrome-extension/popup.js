const status = document.getElementById("status");
const toggle = document.getElementById("toggle");
let paused = false;
async function refresh(type = "status") {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error || "连接失败");
  const result = response.result;
  paused = result.paused;
  toggle.textContent = paused ? "恢复自动连接" : "暂停自动连接";
  const names = { chatgpt: "ChatGPT", gemini: "Gemini", grok: "Grok" };
  status.textContent = paused ? "自动连接已暂停"
    : result.connected ? `AI Hub 已连接；${result.sites.length ? result.sites.map((site) => names[site]).join("、") : "打开并登录 AI 网站后将自动接入"}`
    : result.error || "正在连接本机 AI Hub…";
}
toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try { await refresh(paused ? "resume" : "pause"); }
  catch (error) { status.textContent = error.message; }
  finally { toggle.disabled = false; }
});
void refresh().catch((error) => { status.textContent = error.message; });
setInterval(() => { if (!toggle.disabled) void refresh().catch(() => {}); }, 1500);
