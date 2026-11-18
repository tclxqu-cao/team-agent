import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { MessageAttachment } from "@agent/core";
import { loadMessageImagePreview, localMessageImagePreview } from "../lib/message-image-preview";
import type { MessageImagePreview } from "./MessageImageLightbox";

export default function MessageImageAttachment({ attachment, onPreview }: {
  attachment: MessageAttachment;
  onPreview(image: MessageImagePreview): void;
}) {
  const { imageId, dataUrl, name } = attachment;
  const identity = imageId ?? dataUrl ?? name;
  const [preview, setPreview] = useState<{ identity: string; src?: string; failed?: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const src = preview?.identity === identity ? preview.src : undefined;
  const failed = preview?.identity === identity && preview.failed;

  useEffect(() => {
    let disposed = false;
    let started = false;
    const load = () => {
      if (started || disposed) return;
      started = true;
      const pending = imageId
        ? loadMessageImagePreview(imageId, () => {
          if (!window.agentApi?.getSessionImage) return Promise.reject(new Error("图片服务不可用"));
          return window.agentApi.getSessionImage(imageId, "preview");
        })
        : dataUrl ? localMessageImagePreview(dataUrl) : Promise.reject(new Error("图片不可用"));
      void pending.then(src => { if (!disposed) setPreview({ identity, src }); })
        .catch(() => { if (!disposed) setPreview({ identity, failed: true }); });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); }
    }, { rootMargin: "300px" });
    if (observer && button.current) observer.observe(button.current);
    else load();
    return () => { disposed = true; observer?.disconnect(); };
  }, [dataUrl, identity, imageId]);

  const loadOriginal = async () => {
    if (imageId) {
      if (!window.agentApi?.getSessionImage) throw new Error("图片服务不可用，请刷新后重试");
      return window.agentApi.getSessionImage(imageId, "original");
    }
    if (dataUrl) return dataUrl;
    throw new Error("原图已失效");
  };

  return <button ref={button} type="button" className="chat-message-image-button"
    aria-label={`放大查看图片：${name}`} onClick={() => onPreview({ src: src ?? "", alt: name, loadOriginal })}>
    {src ? <img className="chat-message-attachment-image" src={src} alt={name} title={name} loading="lazy" />
      : <span className="chat-message-image-placeholder" role="status">
        {!failed && <LoaderCircle className="message-image-spinner" size={18} aria-hidden="true" />}
        {failed ? "预览加载失败，点击查看原图" : "正在加载图片…"}
      </span>}
  </button>;
}
