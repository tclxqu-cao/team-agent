/** No user-controlled values or secrets are interpolated into this public page. */
export const PAIRING_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接你的设备 · AgentRoam</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/pwa/icon-192.png"><meta name="theme-color" content="#0b1015"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="AgentRoam">
<style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:radial-gradient(ellipse at 25% 0%,#163638 0,transparent 60%),#0b1015;color:#eaf2f3;padding:24px}main{width:100%;max-width:420px}.brand{color:#8bb6b4;font-size:13px;letter-spacing:3px;margin-bottom:48px}h1{font-size:30px;font-weight:550;letter-spacing:-1px;margin:0 0 12px}p{color:#9baeb7;line-height:1.7;font-size:14px;margin:0 0 28px}label{display:block;font-size:13px;color:#c1d0d6;margin:22px 0 9px}input{width:100%;border:1px solid #34454e;border-radius:10px;background:#121c24;color:#eaf2f3;padding:14px 16px;font:inherit;outline:none}input:focus{border-color:#77cabd;box-shadow:0 0 0 3px #77cabd22}#code{font-size:27px;letter-spacing:7px;font-variant-numeric:tabular-nums}button{width:100%;margin-top:26px;padding:14px;border:0;border-radius:10px;background:#a1dece;color:#0c2822;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.6;cursor:wait}#error{min-height:22px;margin:16px 0;color:#ffb2a7;font-size:14px}[hidden]{display:none!important}.phrase{font-size:26px;letter-spacing:2px;color:#b5ecda;overflow-wrap:anywhere;margin:18px 0}.waiting{padding:20px 0}.hint{border-top:1px solid #273640;padding-top:22px;margin-top:20px;font-size:13px}code{color:#d6e8e7}
video{width:100%;max-height:320px;border-radius:12px;background:#000}#scan-controls button{margin:8px 0 16px}#scan-cancel{margin:10px 0 20px;background:#233c36;color:#b5ecda}</style></head><body><main><div class="brand">AGENTROAM</div><h1>连接你的设备</h1><p>扫描电脑上的授权二维码，直接连接。也可手输配对码，由电脑确认后进入。</p>
<section id="scan-controls" hidden><button id="scan" type="button">扫码直接连接</button><section id="scanner" hidden><video id="camera" playsinline muted></video><button id="scan-cancel" type="button">取消扫码</button></section></section><section id="waiting" class="waiting" hidden aria-live="polite"><h2 id="wait-title">等待电脑批准</h2><p id="wait-copy">请核对电脑和手机显示的短语完全一致，再在电脑上批准。</p><div id="phrase" class="phrase"></div><p id="deadline"></p></section><form id="pair" hidden><label for="code">配对码</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="0000 0000" maxlength="12" required><label for="name">设备名称</label><input id="name" name="name" autocomplete="off" maxlength="80" placeholder="例如：我的 iPhone" required><button id="submit" type="submit">配对并进入</button><div id="error" role="alert" aria-live="polite"></div></form><p class="hint">配对码 5 分钟内有效，仅可使用一次。<br>添加另一台设备：在电脑终端执行 <code>agentroam pair</code>。</p><p class="hint">iPhone：Safari → 分享 → 添加到主屏幕，即可像 App 一样打开，无需签名。</p></main>
<script>
const form=document.getElementById('pair'),waiting=document.getElementById('waiting'),message=document.getElementById('error'),button=document.getElementById('submit');
let pollTimer,clockTimer;
function stop(){clearTimeout(pollTimer);clearInterval(clockTimer);}
function enter(){stop();location.replace(location.pathname.startsWith('/app')?'/app/':'/web');}
function showForm(error=''){stop();document.getElementById('scan-controls').hidden=false;waiting.hidden=true;form.hidden=false;button.disabled=false;message.textContent=error;}
function locked(){stop();document.getElementById('scan-controls').hidden=true;form.hidden=true;waiting.hidden=false;document.querySelector('h1').textContent='远程访问已锁定';document.getElementById('wait-title').textContent='请在电脑上解锁';document.getElementById('wait-copy').textContent='所有设备授权和待用配对已取消。电脑解锁后，需要重新生成配对码。';document.getElementById('phrase').textContent='';document.getElementById('deadline').textContent='';}
function showRequest(request){document.getElementById('scan-controls').hidden=true;
 form.hidden=true;waiting.hidden=false;document.getElementById('phrase').textContent=request.phrase;
 document.getElementById('wait-title').textContent='等待电脑批准';
 clearInterval(clockTimer);
 const tick=()=>{const seconds=Math.max(0,Math.ceil((request.expires-Date.now())/1000));document.getElementById('deadline').textContent='剩余 '+seconds+' 秒';if(!seconds)showForm('授权请求已过期，请在电脑上重新生成配对码。');};tick();clockTimer=setInterval(tick,1000);
}
async function poll(initial=false){
 try{
  const response=await fetch('/api/pairing/poll',{method:'POST',credentials:'same-origin',cache:'no-store'});
  const result=await response.json();
  if(response.status===423){locked();return;}
  if(!response.ok){showForm(initial?'':result.error||'授权已失效，请重新配对。');return;}
  if(result.device){enter();return;}
  if(result.request.status==='denied'){showForm('电脑已拒绝此请求，请核实后重新配对。');return;}
  showRequest(result.request);pollTimer=setTimeout(()=>poll(),1000);
 }catch{document.getElementById('deadline').textContent='连接暂时中断，正在重试…';pollTimer=setTimeout(()=>poll(initial),2000);}
}
form.addEventListener('submit',async(event)=>{
 event.preventDefault();stop();button.disabled=true;message.textContent='';
 try{
  const response=await fetch('/api/pairing/exchange',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value,name:document.getElementById('name').value})});
  const result=await response.json();if(response.status===423){locked();return;}if(!response.ok)throw new Error(result.error||'配对失败');
  showRequest(result.request);pollTimer=setTimeout(()=>poll(),800);
 }catch(e){showForm(e.message||'无法连接，请重试');}
});
async function exchangeQr(grant){
 stop();button.disabled=true;document.getElementById('scan-controls').hidden=true;message.textContent='正在连接…';
 try{
  const response=await fetch('/api/pairing/qr-exchange',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({grant,name:document.getElementById('name').value||'我的手机'})});
  const result=await response.json();if(response.status===423){locked();return;}if(!response.ok)throw new Error(result.error||'二维码授权失败');enter();
 }catch(e){showForm(e.message||'无法连接，请重试。');}
}
const fragment=location.hash,qrGrant=/^#pair=([A-Za-z0-9_-]{43})$/.exec(fragment)?.[1];
if(fragment)history.replaceState(null,'',location.pathname+location.search);
// Strict cookies can be omitted on cross-site navigation, so check again here.
fetch('/api/web-auth/status',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(s=>{if(s.locked)locked();else if(qrGrant)exchangeQr(qrGrant);else if(s.authenticated)enter();else if(fragment.startsWith('#pair'))showForm('授权二维码格式无效，请重新生成。');else poll(true);}).catch(()=>showForm('无法连接，请重试。'));
</script><script src="/pwa/pairing-scan.js" defer></script><script src="/pwa/install.js" defer></script></body></html>`;
