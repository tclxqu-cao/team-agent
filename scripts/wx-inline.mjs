// 把 outputs/公众号文章-agentroam-架构.html 转成公众号可保留样式的内联 HTML
// 输出: /tmp/wx_part_a.html (图片前)  /tmp/wx_part_b.html (图片后)
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync('/Users/caoqu/team-agent/customer-agent/outputs/公众号文章-agentroam-架构.html', 'utf8')
let body = src.split('<div class="page">')[1].split('</div>\n</body>')[0]

// 去掉 h1 / meta（标题单独填，meta 公众号自带）
body = body.replace(/<h1>[\s\S]*?<\/h1>/, '')
body = body.replace(/<div class="meta">[\s\S]*?<\/div>/, '')

// 图片单独上传，先占位
const SPLIT = '<!--IMG-->'
body = body.replace(/<div class="img-wrap">[\s\S]*?<figcaption>[\s\S]*?<\/figcaption>\s*<\/div>/,
  `${SPLIT}\n<section data-role="imgcap" style="font-size:13px;color:#999;text-align:center;margin:10px 0 28px;line-height:1.7;">一张图看懂：你的电脑（文件 / 终端 / Codex / Claude）→ 核心引擎 → 外壳 → 统一会话层（隧道 + 控制台）→ 手机</section>`)

const P = 'margin:0 0 18px;line-height:1.9;font-size:16px;color:#333;'
const H2 = 'font-size:18px;font-weight:bold;margin:44px 0 16px;padding:10px 0 10px 10px;line-height:1.6;border-left:4px solid #1a73e8;color:#1a73e8;'
const LI = 'margin-bottom:10px;line-height:1.9;font-size:16px;color:#333;'

let s = body
s = s.replace(/<h2>/g, `<section style="${H2}">`).replace(/<\/h2>/g, '</section>')
s = s.replace(/<p>/g, `<p style="${P}">`)
s = s.replace(/<ul>/g, '<ul style="padding-left:22px;margin:0 0 18px;">')
s = s.replace(/<li>/g, `<li style="${LI}">`)
s = s.replace(/<code class="cmd">/g, '<pre style="background:#1e1e1e;color:#d4d4d4;padding:14px 18px;border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:14px;line-height:1.7;margin:20px 0;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">')
s = s.replace(/<\/code>/g, '</pre>')
s = s.replace(/<code>/g, '<code style="background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:14px;font-family:Menlo,Consolas,monospace;color:#c7254e;">')
s = s.replace(/<table>/g, '<table style="width:100%;border-collapse:collapse;margin:18px 0 22px;font-size:14px;">')
s = s.replace(/<th>/g, '<th style="border:1px solid #e3e3e3;padding:10px 12px;text-align:left;background:#f5f8ff;color:#1a73e8;font-weight:600;">')
s = s.replace(/<td>/g, '<td style="border:1px solid #e3e3e3;padding:10px 12px;text-align:left;vertical-align:top;">')
s = s.replace(/<div class="warn">/g, '<section style="background:#fff8e6;border-left:3px solid #f0a500;padding:14px 16px;font-size:15px;color:#6b5220;line-height:1.8;margin:20px 0 24px;border-radius:0 6px 6px 0;">')
s = s.replace(/<div class="footer">/g, '<section style="margin-top:56px;padding-top:20px;border-top:1px solid #eee;font-size:13px;color:#aaa;text-align:center;line-height:1.8;">')
s = s.replace(/<div class="img-wrap">/g, '<section style="text-align:center;">')
s = s.replace(/<\/div>/g, '</section>')
s = s.replace(/<strong>/g, '<strong style="color:#111;">')
s = s.replace(/\n\s*\n/g, '\n')

const [a, b] = s.split(SPLIT)
writeFileSync('/tmp/wx_part_a.html', a.trim())
writeFileSync('/tmp/wx_part_b.html', b.trim())
console.log('part_a bytes:', Buffer.byteLength(a.trim()))
console.log('part_b bytes:', Buffer.byteLength(b.trim()))
console.log('--- part_b head ---')
console.log(b.trim().slice(0, 400))
