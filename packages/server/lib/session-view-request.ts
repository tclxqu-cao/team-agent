import { SESSION_VIEW_BATCH_SIZE } from "@agent/core";
import { z } from "zod";

export const sessionViewRequest = z.object({
  afterRevision: z.number().int().nonnegative(),
  views: z.array(z.object({
    sessionId: z.string().min(1).max(400),
    viewedAt: z.number().int().positive(),
  })).max(SESSION_VIEW_BATCH_SIZE),
});
