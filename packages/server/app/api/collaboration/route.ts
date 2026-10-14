import { NextResponse } from "next/server";
import { z } from "zod";
import {
  COLLABORATION_AGENTS,
  CollaborationError,
  HostPathError,
  HostPathPolicy,
  type CollaborationCommand,
} from "@agent/core";
import { homedir } from "node:os";
import { agentHost, ProjectWorkingDirectoryError } from "../agent-host";
import { collaborationService } from "../../../lib/collaboration/service";

const id = z.string().min(1).max(200);
const groupSchema = z.object({
  name: z.string().min(1).max(100),
  cwd: z.string().min(1).max(4000),
  projectId: id.optional(),
  ownerId: id,
  maxParallel: z.number().int().min(1).max(20),
  members: z
    .array(
      z.object({
        id,
        name: z.string().min(1).max(100),
        agentType: z.enum(COLLABORATION_AGENTS),
        role: z.string().max(8000),
        profileId: id.optional(),
        model: z
          .object({
            id: z.string().min(1).max(300),
            providerID: z.string().max(200).optional(),
          })
          .optional(),
      }),
    )
    .min(2)
    .max(20),
});
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("groups") }),
  z.object({ action: z.literal("group"), groupId: id }),
  z.object({
    action: z.literal("updateGroup"),
    groupId: id,
    group: groupSchema,
  }),
  z.object({ action: z.literal("deleteGroup"), groupId: id }),
  z.object({
    action: z.literal("updateRole"),
    groupId: id,
    memberId: id,
    role: z.string().max(8000),
  }),
  z.object({ action: z.literal("discussions"), groupId: id }),
  z.object({ action: z.literal("createDiscussion"), groupId: id }),
  z.object({
    action: z.literal("discussion"),
    discussionId: id,
    afterRevision: z.number().int().nonnegative().optional(),
  }),
  z.object({
    action: z.literal("send"),
    discussionId: id,
    text: z.string().min(1).max(100000),
    messageId: id,
  }),
  z.object({ action: z.literal("stop"), discussionId: id }),
  z.object({ action: z.literal("resume"), discussionId: id }),
  z.object({
    action: z.literal("answer"),
    discussionId: id,
    questionId: id,
    answer: z.string().min(1).max(10000),
    selectedIndices: z.array(z.number().int().nonnegative()).max(50).optional(),
  }),
  z.object({
    action: z.literal("createGroup"),
    group: groupSchema,
  }),
]);

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json()) as CollaborationCommand;
    if (body.action === "createGroup" || body.action === "updateGroup") {
      body.group.cwd = body.group.projectId
        ? await agentHost.resolveProjectWorkingDirectory(
            body.group.projectId,
            true,
          )
        : HostPathPolicy.fromEnvironment(
            process.env.AGENT_WEB_ROOTS,
            homedir(),
          ).assertDirectory(body.group.cwd);
    }
    return NextResponse.json(await collaborationService().command(body));
  } catch (error) {
    const status =
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof HostPathError
        ? 400
        : error instanceof ProjectWorkingDirectoryError
          ? error.status
          : error instanceof CollaborationError
            ? error.code === "NOT_FOUND"
              ? 404
              : 409
            : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "群协作请求失败" },
      { status },
    );
  }
}
