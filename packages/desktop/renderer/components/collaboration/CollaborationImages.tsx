import { X } from "lucide-react";

export default function CollaborationImages({ images, onPreview, onRemove }: {
  images: string[];
  onPreview: (src: string) => void;
  onRemove?: (index: number) => void;
}) {
  if (!images.length) return null;
  return <div className={`collab-images${onRemove ? " is-draft" : ""}`} aria-label={onRemove ? "待发送图片" : "消息图片"}>
    {images.map((src, index) => <div className="collab-image" key={index}>
      <button type="button" className="collab-image-preview" aria-label={`查看图片 ${index + 1}`} onClick={() => onPreview(src)}>
        <img src={src} alt={`图片 ${index + 1}`} loading="lazy"/>
      </button>
      {onRemove && <button type="button" className="collab-image-remove" aria-label={`移除图片 ${index + 1}`} onClick={() => onRemove(index)}><X size={13}/></button>}
    </div>)}
  </div>;
}
