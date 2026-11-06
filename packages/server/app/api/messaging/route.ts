import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENT_TYPES } from "@agent/core";
import { messagingService } from "../../../lib/messaging/service";

export const dynamic = "force-dynamic";
const id = z.string().trim().min(1).max(500);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), before: z.string().max(1000).optional(), query: z.string().max(500).optional(), filter: z.enum(["all", "addressed", "mentioned", "review", "running", "completed", "deliveryFailed"]).optional() }),
  z.object({ action: z.literal("detail"), id }),
  z.object({ action: z.literal("settings") }),
  z.object({ action: z.literal("discover") }),
  z.object({ action: z.literal("retryDelivery"), id }),
  z.object({ action: z.literal("resolve"), id, projectId: id, agentType: z.enum(AGENT_TYPES) }),
  z.object({ action: z.literal("saveSettings"), settings: z.object({
    enabled: z.boolean(), routingMode: z.enum(["model", "rules"]),
    source: z.object({ database: z.string().max(4000), accountId: z.string().max(100).regex(/^\d*$/) }),
    rules: z.array(z.object({ conversationId: id, projectId: id, agentType: z.enum(AGENT_TYPES) })).max(500),
    subscriptions: z.array(z.object({ id, enabled: z.boolean(), events: z.array(z.enum(["completed", "failed", "waiting"])).min(1).max(3), kind: z.enum(["wecom", "webhook"]), address: id, label: z.string().max(200) })).max(20),
  }) }),
]);
export async function GET() {
  return NextResponse.json({ worker: messagingService().repository.worker() });
}
export async function POST(request: Request) {
  try {
    const command = schema.parse(await request.json());
    const { repository, service, worker, execution, intake } = messagingService();
    switch (command.action) {
      case "list": return NextResponse.json(repository.list(command));
      case "detail": {
        const message = repository.get(command.id);
        if (!message) return NextResponse.json({ error: "消息不存在" }, { status: 404 });
        return NextResponse.json({ message, deliveries: repository.deliveries(command.id) });
      }
      case "settings": return NextResponse.json({ settings: repository.settings(), candidates: await execution.candidates(), worker: repository.worker() });
      case "discover": return NextResponse.json(await intake.discover());
      case "saveSettings": {
        const rules = new Set<string>();
        for (const rule of command.settings.rules) { if (rules.has(rule.conversationId)) throw new Error("同一个群只保留一条规则"); rules.add(rule.conversationId); }
        for (const item of command.settings.subscriptions) if (item.kind === "webhook") {
          const url = new URL(item.address);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("通知地址必须为 HTTP(S)");
        }
        repository.saveSettings(command.settings);
        if (command.settings.enabled) repository.status({ state: "starting", updatedAt: new Date().toISOString() });
        void worker.tick();
        return NextResponse.json(repository.settings());
      }
      case "retryDelivery": service.retryDelivery(command.id); void worker.tick(); return NextResponse.json({ accepted: true });
      case "resolve": return NextResponse.json(await service.resolve(command.id, {
        action: "dispatch", projectId: command.projectId, agentType: command.agentType, reason: "用户手动选择执行目标",
      }));
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "消息接入请求失败" }, { status: 400 });
  }
}
