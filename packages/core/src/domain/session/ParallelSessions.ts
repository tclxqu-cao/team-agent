import { AGENT_TYPES, isAgentType, type AgentType } from "../agent/agent-type.js";

export interface ParallelSessionIdentity { id: string; agentType: AgentType }

/** An association of independent sessions; transcripts stay in their original runtime. */
export interface ParallelSessionGroup<T extends ParallelSessionIdentity = ParallelSessionIdentity> {
  id: string;
  title: string;
  cwd: string;
  created: string;
  members: T[];
}

export interface CreateParallelSessionsInput {
  title: string;
  cwd: string;
  agentTypes: AgentType[];
}

export function parallelAgentTypes(value: unknown): AgentType[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > AGENT_TYPES.length
    || !value.every(isAgentType) || new Set(value).size !== value.length) {
    throw new Error("请选择至少两位不同的 Agent");
  }
  return [...value];
}

export async function createParallelSessions<T extends ParallelSessionIdentity>(
  input: CreateParallelSessionsInput,
  ports: {
    create(agentType: AgentType, title: string, cwd: string): Promise<T>;
    remove(id: string): Promise<void>;
    save(group: ParallelSessionGroup<T>): void | Promise<void>;
  },
): Promise<ParallelSessionGroup<T>> {
  const agentTypes = parallelAgentTypes(input.agentTypes);
  if (!input.cwd.trim()) throw new Error("请先选择会话目录");
  const results = await Promise.allSettled(agentTypes.map(type => ports.create(type, input.title, input.cwd)));
  const members = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  try {
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [`${agentTypes[index]}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
    if (failures.length) throw new Error(`创建会话失败：${failures.join("；")}`);
    const group: ParallelSessionGroup<T> = {
      id: crypto.randomUUID(), title: input.title, cwd: input.cwd,
      created: new Date().toISOString(), members,
    };
    await ports.save(group);
    return group;
  } catch (error) {
    // No prompts have been submitted yet. Roll back only this attempt's empty sessions.
    const rollback = await Promise.allSettled(members.map(member => ports.remove(member.id)));
    const retained = members.filter((_, index) => rollback[index].status === "rejected");
    if (retained.length) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}；部分空会话未能清理：${retained.map(member => member.agentType).join("、")}`);
    }
    throw error;
  }
}
