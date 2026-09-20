import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSnapshot,
  isSensitiveNode,
  nodeCenter,
  parseAndroidXml,
  parseWdaXml,
} from "../src/perception/ui-tree.js";

const fixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

describe("uiautomator XML 解析", () => {
  const xml = fixture("uiautomator-sample.xml");

  it("解析属性与 bounds", () => {
    const nodes = parseAndroidXml(xml);
    // root + 6 个子节点
    expect(nodes.length).toBe(7);
    const search = nodes[1];
    expect(search.clickable).toBe(true);
    expect(search.desc).toBe("搜索");
    expect(search.x).toBe(54);
    expect(search.y).toBe(120);
    expect(search.w).toBe(972);
    expect(search.h).toBe(100);
    expect(search.id).toBe("search_bar");
  });

  it("解码 XML 实体", () => {
    const nodes = parseAndroidXml(xml);
    expect(nodes[2].text).toBe("AirPods Pro 2 & 降噪");
    expect(nodes[3].text).toBe("¥1899");
  });

  it("过滤无信息节点并保留 NAF 节点剔除逻辑", () => {
    const snapshot = buildSnapshot({ driverKind: "adb", xml, app: "com.taobao.taobao", maxLines: 150 });
    // 空文本且不可点击的 FrameLayout / NAF View 被过滤
    expect(snapshot.nodes.some((n) => n.text === "" && !n.clickable && n.desc === "")).toBe(false);
    // 保留：搜索栏、标题、价格、加入购物车、立即购买
    expect(snapshot.nodes).toHaveLength(5);
    expect(snapshot.nodes[0].index).toBe(1);
    expect(snapshot.rendered).toContain("[3]");
    expect(snapshot.rendered).toContain("加入购物车");
  });

  it("maxLines 截断并在头部提示", () => {
    const snapshot = buildSnapshot({ driverKind: "adb", xml, app: "x", maxLines: 3 });
    expect(snapshot.nodes).toHaveLength(3);
    expect(snapshot.rendered).toContain("仅显示前 3 个");
  });
});

describe("WDA source XML 解析", () => {
  const xml = fixture("wda-source-sample.xml");

  it("解析坐标尺寸与可见性过滤", () => {
    const snapshot = buildSnapshot({ driverKind: "wda", xml, app: "com.taobao", maxLines: 150 });
    // hidden 按钮 visible=false 被过滤
    expect(snapshot.nodes).toHaveLength(3);
    const buy = snapshot.nodes[2];
    expect(buy.cls).toBe("Button");
    expect(buy.text).toBe("立即购买");
    const center = nodeCenter(buy);
    expect(center).toEqual({ x: 200, y: 820 });
  });
});

describe("敏感操作识别", () => {
  it("支付/密码类文案命中", () => {
    expect(isSensitiveNode({ text: "立即购买", desc: "", cls: "Button", id: "", clickable: true, x: 0, y: 0, w: 1, h: 1 } as never)).toBe(true);
    expect(isSensitiveNode({ text: "", desc: "确认支付", cls: "", id: "", clickable: true, x: 0, y: 0, w: 1, h: 1 } as never)).toBe(true);
    expect(isSensitiveNode({ text: "加入购物车", desc: "", cls: "", id: "", clickable: true, x: 0, y: 0, w: 1, h: 1 } as never)).toBe(false);
  });
});
