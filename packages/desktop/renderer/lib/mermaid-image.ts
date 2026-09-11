import { renderMermaid } from "./mermaid-renderer";

export interface DiagramSize {
  width: number;
  height: number;
}

export function getDiagramSize(svg: string): DiagramSize {
  const bounds = svg.match(/<svg\b[^>]*\bviewBox=["']([^"']+)["']/i)?.[1].trim().split(/[\s,]+/).map(Number);
  if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= 0 || bounds[3] <= 0) {
    return { width: 640, height: 480 };
  }
  return { width: bounds[2], height: bounds[3] };
}

export function fitDiagramScale(size: DiagramSize, width: number, height?: number): number {
  return Math.max(0.001, Math.min(1, Math.max(1, width) / size.width, height === undefined ? 1 : Math.max(1, height) / size.height));
}

export function clampDiagramScale(scale: number, fit: number): number {
  return Math.min(4, Math.max(Math.min(0.1, fit), scale));
}

export function getPngSize(size: DiagramSize): DiagramSize {
  const scale = Math.min(2, 4096 / size.width, 4096 / size.height);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

export async function exportMermaidPng(code: string): Promise<Blob> {
  const svg = await renderMermaid(code, true);
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror, foreignObject")) {
    throw new Error("此图包含暂不支持导出的内容，请查看源码。");
  }
  if ([...document.querySelectorAll("image")].some((image) => !String(image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "").startsWith("data:"))) {
    throw new Error("此图包含外部图片，暂不能导出 PNG。");
  }
  const size = getPngSize(getDiagramSize(svg));
  const root = document.documentElement;
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  root.setAttribute("width", String(size.width));
  root.setAttribute("height", String(size.height));
  root.style.maxWidth = "none";
  root.style.width = `${size.width}px`;
  root.style.height = `${size.height}px`;
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图表图片转换失败，请重试。"));
      image.src = url;
    });
    const canvas = window.document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法导出图片。");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片导出失败，请重试。")), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
