import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface MessageImagePreview {
  src: string;
  alt: string;
}

interface MessageImageLightboxProps {
  image: MessageImagePreview | null;
  onClose: () => void;
}

export default function MessageImageLightbox({ image, onClose }: MessageImageLightboxProps) {
  useEffect(() => {
    if (!image) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [image, onClose]);

  if (!image) return null;

  return createPortal(
    <div
      className="message-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <img className="message-image-lightbox__image" src={image.src} alt={image.alt} />
      <button
        type="button"
        className="message-image-lightbox__close"
        onClick={onClose}
        aria-label="关闭图片预览"
        title="关闭"
        autoFocus
      >
        <X size={22} aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
