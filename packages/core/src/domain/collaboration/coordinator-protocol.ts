import { z } from "zod";
import { CollaborationError, type CollaborationDecision } from "./types.js";

const decisionSchema = z
  .object({
    action: z.enum(["dispatch", "wait", "ask", "finish"]),
    message: z.string().max(100000),
    cancelTaskIds: z.array(z.string()).max(100).default([]),
    roles: z
      .array(
        z
          .object({
            memberId: z.string().min(1),
            role: z.string().min(1).max(8000),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    tasks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
            memberId: z.string().min(1),
            title: z.string().min(1).max(200),
            instructions: z.string().min(1).max(30000),
            dependsOn: z.array(z.string()).max(100).default([]),
            isolated: z.boolean().default(false),
            readOnly: z.boolean().default(false),
            verification: z
              .object({ command: z.string().min(1).max(2000) })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict()
  .refine((decision) => decision.action === "finish" || !!decision.message.trim());

export function parseCollaborationDecision(
  text: string,
): CollaborationDecision {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  try {
    return decisionSchema.parse(JSON.parse(fenced ? fenced[1] : trimmed));
  } catch {
    throw new CollaborationError(
      "群主未返回有效的协作决策，请只返回约定的 JSON",
    );
  }
}
