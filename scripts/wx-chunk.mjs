// 把 /tmp/wx_part_a.html 拆成顶层块，按 ~1200 字节分组，输出 /tmp/wx_chunks.json
import { readFileSync, writeFileSync } from 'node:fs'

const html = readFileSync(process.argv[2], 'utf8')
const VOID = new Set(['br', 'img', 'hr'])
const blocks = []
let i = 0
while (i < html.length) {
  if (html[i] !== '<') { i++; continue }
  const m = /^<([a-zA-Z0-9]+)/.exec(html.slice(i))
  if (!m) { i++; continue }
  const tag = m[1].toLowerCase()
  const closeIdx = html.indexOf('>', i)
  if (closeIdx < 0) break
  const openTagText = html.slice(i, closeIdx + 1)
  if (VOID.has(tag) || openTagText.endsWith('/>')) { blocks.push(openTagText); i = closeIdx + 1; continue }
  // 找到匹配的闭合标签（处理同名嵌套）
  let depth = 0, j = i
  const re = new RegExp('<' + tag + '(\\s|>|/)|</' + tag + '>', 'gi')
  let mm, end = -1
  re.lastIndex = i
  while ((mm = re.exec(html))) {
    if (mm[0].toLowerCase().startsWith('</')) {
      depth--
      if (depth === 0) { end = mm.index; break }
    } else if (!mm[0].endsWith('/>')) {
      depth++
      re.lastIndex = mm.index + mm[0].length
    }
  }
  if (end < 0) { i = closeIdx + 1; continue }
  const closeEnd = html.indexOf('>', end) + 1
  blocks.push(html.slice(i, closeEnd))
  i = closeEnd
}

// 分组
const MAX = 1200
const groups = []
let cur = ''
for (const b of blocks) {
  if (cur && Buffer.byteLength(cur + b, 'utf8') > MAX) { groups.push(cur); cur = '' }
  cur += b
}
if (cur) groups.push(cur)

writeFileSync('/tmp/wx_chunks.json', JSON.stringify(groups))
console.log('blocks:', blocks.length, 'groups:', groups.length)
console.log('group sizes:', groups.map(g => Buffer.byteLength(g, 'utf8')).join(','))
