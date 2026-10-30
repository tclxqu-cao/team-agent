import { NextResponse } from "next/server";
import { z } from "zod";
import {
  COLLABORATION_AGENTS,
  AGENT_TYPES,
  CollaborationError,
  HostPathError,
  HostPathPolicy,
  type CollaborationCommand,
} from "@agent/core";
import { homedir } from "node:os";
import { agentHost, ProjectWorkingDirectoryError } from "../agent-host";
import { collaborationService } from "../../../lib/collaboration/service";
import { supervisionService } from "../../../lib/supervision/service";
import { querySessionCatalog } from "../../../lib/session-catalog";
import { sessionDashboard } from "../../../lib/collaboration/dashboard";

const id = z.string().min(1).max(200);
const groupSchema = z.object({
  name: z.string().min(1).max(100),
  cwd: z.string().min(1).max(4000),
  projectId: id.optional(),
  ownerId: id,
  maxParallel: z.number().int().min(1).max(20),
  monitoring: z.object({
    supervisorId: id.optional(),
    targets: z.array(z.object({
      id: z.string().min(1).max(400), agentType: z.enum(AGENT_TYPES),
      title: z.string().min(1).max(1000), cwd: z.string().min(1).max(4000), projectId: id.optional(),
    })).max(200),
  }).optional(),
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
const mode = z.enum(["task-graph", "chat"]);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sessionCatalog"), query: z.string().max(1000).optional(), cursor: z.string().max(300).optional(), limit: z.number().int().min(1).max(100).optional() }),
  z.object({ action: z.literal("dashboard") }),
  z.object({ action: z.literal("supervisionAlerts") }),
  z.object({ action: z.literal("supervision"), groupId: id }),
  z.object({ action: z.literal("applySupervision"), groupId: id }),
  z.object({ action: z.literal("pauseSupervision"), groupId: id, paused: z.boolean() }),
  z.object({ action: z.literal("answerSupervision"), groupId: id, incidentId: id, answer: z.string().min(1).max(10000), selectedIndices: z.array(z.number().int().nonnegative()).max(50).optional() }),
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
  z.object({
    action: z.literal("createDiscussion"),
    groupId: id,
    mode: mode.optional(),
  }),
  z.object({ action: z.literal("setMode"), discussionId: id, mode }),
  z.object({ action: z.literal("answerDecision"), discussionId: id, expectedRevision: z.number().int().nonnegative(), answer: z.string().min(1).max(10000), messageId: id }),
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
    const supervision = supervisionService();
    switch (body.action) {
      case "sessionCatalog": return NextResponse.json(await querySessionCatalog(body));
      case "dashboard": return NextResponse.json(await sessionDashboard());
      case "supervisionAlerts": return NextResponse.json(collaborationService().repository.listGroups().flatMap(group => {
        const scope = supervision.repository.get(group.id);
        return (scope?.incidents ?? []).filter(incident => incident.status === "waiting" || incident.status === "resolved" && incident.notifiedAt && ["recovery", "handoff", "delivery"].includes(incident.kind)).slice(-30).map(incident => ({ groupName: group.name, incident, target: scope?.group.monitoring?.targets.find(target => target.id === incident.sessionId) }));
      }));
      case "supervision": return NextResponse.json(supervision.repository.get(body.groupId));
      case "applySupervision": return NextResponse.json(supervision.apply(body.groupId));
      case "pauseSupervision": return NextResponse.json(supervision.pause(body.groupId, body.paused));
      case "answerSupervision": return NextResponse.json(await supervision.answer(body.groupId, body.incidentId, body.answer, body.selectedIndices));
    }
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
