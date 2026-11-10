import type { NativeModelCatalogStatus } from "../lib/use-native-model-catalog";

export default function NativeModelCatalogNotice({ status, error, onRetry }: {
  status: NativeModelCatalogStatus;
  error: string | null;
  onRetry: () => void;
}) {
  if (status === "ready") return null;
  const label = status === "loading" ? "模型加载中"
    : status === "error" ? "模型加载失败"
    : status === "unsupported" ? "暂不支持选择模型" : "暂无可选模型";
  return <span className="web-native-model-notice">
    <span role={status === "error" ? "alert" : "status"} title={error ?? label}>{label}</span>
    {status !== "loading" && <button type="button" aria-label="重新加载模型列表" onClick={onRetry}>重试</button>}
  </span>;
}
