import type { MessagingCommand } from "@agent/messaging";

export async function messagingRequest<T>(command: MessagingCommand): Promise<T> {
  if (!window.agentApi?.messaging) throw new Error("当前服务尚未提供消息接入，请连接更新后的服务");
  return await window.agentApi.messaging(command) as T;
}
export const EXECUTION_LABELS = {
  pending: "尚未派发", dispatching: "确认接收中", queued: "排队中", running: "执行中",
  waiting: "等待确认", completed: "已完成", failed: "执行失败", aborted: "已中断", unknown: "待核对",
};
export const DELIVERY_LABELS = {
  none: "尚未回传", pending: "等待回传", sending: "发送中", sent: "已回传",
  failed: "回传失败", unknown: "送达待核对", blocked: "通道未就绪",
};
export function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}
