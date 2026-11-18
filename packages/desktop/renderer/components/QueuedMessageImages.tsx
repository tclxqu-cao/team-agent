import type { MessageImagePreview } from "./MessageImageLightbox";

export default function QueuedMessageImages({ images, onPreview }: {
  images?: readonly string[];
  onPreview(image: MessageImagePreview): void;
}) {
  if (!images?.length) return null;
  return <span className="queued-message-images" aria-label={`${images.length} 张排队图片`}>
    {images.map((src, index) => <button type="button" key={index} className="queued-message-image-button"
      aria-label={`放大查看排队图片 ${index + 1}`} onClick={() => onPreview({ src, alt: `排队图片 ${index + 1}` })}>
      <img src={src} alt={`排队图片 ${index + 1}`} loading="lazy" draggable={false} />
    </button>)}
  </span>;
}
