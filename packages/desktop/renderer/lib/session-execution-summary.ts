import { validCompletionDurationMs } from "./message-actions";

export function formatSessionWorkDuration(value: unknown, includeSeconds = false): string {
  const duration = validCompletionDurationMs(value);
  if (duration === undefined) return "已工作";
  const seconds = Math.round(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `已工作 ${hours} 时 ${minutes % 60} 分${includeSeconds ? ` ${seconds % 60} 秒` : ""}`;
  return minutes > 0
    ? `已工作 ${minutes} 分${includeSeconds || seconds % 60 ? ` ${seconds % 60} 秒` : ""}`
    : `已工作 ${seconds} 秒`;
}
