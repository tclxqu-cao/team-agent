/** 无障碍树解析：uiautomator XML（Android）与 WDA source XML（iOS）→ 统一紧凑文本 + 可定位节点。 */

export interface UiNode {
  /** 渲染序号（phone_tap index 引用它） */
  index: number;
  text: string;
  desc: string;
  cls: string;
  /** resource-id (Android) 或 name (iOS) */
  id: string;
  clickable: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiSnapshot {
  driverKind: "adb" | "wda";
  nodes: UiNode[];
  /** 渲染后的紧凑文本（发给模型的） */
  rendered: string;
  capturedAt: number;
  app: string;
}

interface RawNode {
  text: string;
  desc: string;
  cls: string;
  id: string;
  clickable: boolean;
  visible: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/** 解析一个 XML 标签的属性为 map（容忍无值属性）。 */
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) attrs[m[1]] = decodeXml(m[2]);
  return attrs;
}

/** Android bounds 字符串 "[0,100][540,300]" → x,y,w,h */
function parseBounds(s: string): { x: number; y: number; w: number; h: number } | null {
  const m = /\[(-?\d+)\s*,\s*(-?\d+)\]\[(-?\d+)\s*,\s*(-?\d+)\]/.exec(s);
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

function visibleText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** uiautomator dump XML → RawNode 列表（保序）。 */
export function parseAndroidXml(xml: string): RawNode[] {
  const nodes: RawNode[] = [];
  const tagRe = /<node\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const a = parseAttrs(m[0]);
    const bounds = parseBounds(a.bounds ?? "");
    if (!bounds) continue;
    nodes.push({
      text: visibleText(a.text ?? ""),
      desc: visibleText(a["content-desc"] ?? ""),
      cls: a.class ?? "",
      id: (a["resource-id"] ?? "").replace(/^.*?:id\//, ""),
      clickable: a.clickable === "true",
      visible: a["NAF"] !== "true",
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
    });
  }
  return nodes;
}

/** WDA /source XML（XCUIElementType 标签）→ RawNode 列表（保序）。 */
export function parseWdaXml(xml: string): RawNode[] {
  const nodes: RawNode[] = [];
  const tagRe = /<(XCUIElementType\w+)\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const a = parseAttrs(m[2]);
    const x = Number(a.x ?? "0");
    const y = Number(a.y ?? "0");
    const w = Number(a.width ?? "0");
    const h = Number(a.height ?? "0");
    if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) continue;
    nodes.push({
      text: visibleText(a.label ?? a.value ?? ""),
      desc: "",
      cls: m[1].replace(/^XCUIElementType/, ""),
      id: a.name ?? "",
      clickable: true,
      visible: a.visible !== "false",
      x,
      y,
      w,
      h,
    });
  }
  return nodes;
}

function shouldKeep(n: RawNode): boolean {
  if (!n.visible) return false;
  // 只保留有信息量的节点：可点击、有文本、有描述/标识
  return n.clickable || n.text !== "" || n.desc !== "";
}

export function renderNode(n: UiNode): string {
  const parts = [`[${n.index}]`];
  if (n.cls) parts.push(n.cls);
  const label = n.text || n.desc;
  if (label) parts.push(`"${label}"`);
  if (n.id) parts.push(`id=${n.id}`);
  if (n.clickable) parts.push("clickable");
  parts.push(`@ (${Math.round(n.x + n.w / 2)},${Math.round(n.y + n.h / 2)} ${Math.round(n.w)}x${Math.round(n.h)})`);
  return parts.join(" ");
}

export interface BuildSnapshotOptions {
  driverKind: "adb" | "wda";
  xml: string;
  app: string;
  maxLines: number;
}

/** XML → UiSnapshot：过滤、编号、渲染紧凑文本。 */
export function buildSnapshot(opts: BuildSnapshotOptions): UiSnapshot {
  const raw = opts.driverKind === "adb" ? parseAndroidXml(opts.xml) : parseWdaXml(opts.xml);
  const kept = raw.filter(shouldKeep);
  const truncated = kept.length > opts.maxLines;
  const shown = truncated ? kept.slice(0, opts.maxLines) : kept;
  const nodes: UiNode[] = shown.map((n, i) => ({ ...n, index: i + 1 }));
  const header = `# 屏幕 app=${opts.app} 元素=${kept.length}${truncated ? `（仅显示前 ${opts.maxLines} 个，可先 phone_swipe 再刷新）` : ""}`;
  const rendered = [header, ...nodes.map(renderNode)].join("\n");
  return { driverKind: opts.driverKind, nodes, rendered, capturedAt: Date.now(), app: opts.app };
}

/** 节点中心点。 */
export function nodeCenter(n: UiNode): { x: number; y: number } {
  return { x: Math.round(n.x + n.w / 2), y: Math.round(n.y + n.h / 2) };
}

/** 敏感操作识别：支付/密码/验证码类按钮要点前先向用户确认。 */
export function isSensitiveNode(n: UiNode): boolean {
  const label = `${n.text} ${n.desc} ${n.id}`;
  return /(支付|付款|立即购买|提交订单|确认订单|去结算|密码|验证码|指纹|刷脸|人脸|免密)/.test(label);
}
