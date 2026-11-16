import { validCompletionDurationMs } from "./message-actions";

export function formatSessionWorkDuration(value: unknown): string {
  const duration = validCompletionDurationMs(value);
  if (duration === undefined) return "执行过程";
  const seconds = Math.round(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0
    ? `已工作 ${minutes} 分 ${seconds % 60} 秒`
    : `已工作 ${seconds} 秒`;
}
