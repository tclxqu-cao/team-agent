import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { pathToFileURL } from "node:url";
import * as Core from "@agent/core";
import type { AgentEvent, AskUserRequest, AskUserResponse, IAgentLoop, SkillMeta } from "@agent/core";
import type { ModelSelection } from "./model-config.js";

export interface SessionSummary {
  id: string;
  title: string;
  created: string;
}

export type QuestionHandler = (request: AskUserRequest) => Promise<AskUserResponse>;

export interface RuntimeSnapshot {
  workingDirectory: string;
  model: ModelSelection;
  sessionId: string;
  skills: SkillMeta[];
}

type AgentBuildResult = { agent: IAgentLoop; skills: SkillMeta[] };
type AgentFactory = (workingDirectory: string, model: ModelSelection, question: QuestionHandler) => Promise<AgentBuildResult>;

export class TuiRuntime {
  private agent: IAgentLoop | null = null;
  private skillsCache: SkillMeta[] = [];
  private currentSessionId = "";
  private questionHandler: QuestionHandler = async () => ({ answer: "" });

  constructor(
    private workingDirectory: string,
    private model: ModelSelection,
    private readonly storeDir: string,
    private readonly sessionStore: Core.ISessionStore = new Core.FileSystemSessionStore(storeDir),
    private readonly agentFactory: AgentFactory = TuiRuntime.defaultAgentFactory(sessionStore),
  ) {}

  private static defaultAgentFactory(sessionStore: Core.ISessionStore): AgentFactory {
    return async (workingDirectory, model, question) => {
      const builder = new Core.AgentBuilder()
        .withWorkingDirectory(workingDirectory)
        .withSessionStore(sessionStore)
        .withModel(model.provider, {
          apiKey: model.apiKey,
          modelId: model.modelId,
          baseUrl: model.baseUrl,
        })
        .withTool(new Core.AskUserTool(question));
      const agent = await builder.build();
      return { agent, skills: builder.getSkillRegistry().getAll() };
    };
  }

  setQuestionHandler(handler: QuestionHandler): void {
    this.questionHandler = handler;
  }

  async initialize(): Promise<RuntimeSnapshot> {
    await fsp.mkdir(this.storeDir, { recursive: true });
    const built = await this.agentFactory(this.workingDirectory, this.model, (request) => this.questionHandler(request));
    this.agent = built.agent;
    this.skillsCache = built.skills;
    await this.newSession();
    process.chdir(this.workingDirectory);
    return this.snapshot();
  }

  snapshot(): RuntimeSnapshot {
    return {
      workingDirectory: this.workingDirectory,
      model: this.model,
      sessionId: this.currentSessionId,
      skills: [...this.skillsCache],
    };
  }

  async newSession(): Promise<string> {
    const now = new Date().toISOString();
    const session = await this.sessionStore.create({
      id: randomUUID(),
      projectId: "",
      title: "TUI 会话",
      status: "idle",
      messages: [],
      events: [],
      created: now,
      updated: now,
      metadata: {
        source: "tui",
        workingDirectory: this.workingDirectory,
        provider: this.model.provider,
        modelId: this.model.modelId,
      },
    });
    this.currentSessionId = session.id;
    return session.id;
  }

  private async readSessions(): Promise<SessionSummary[]> {
    try {
      const sessionDir = `${this.storeDir}/.sessions`;
      const files = (await fsp.readdir(sessionDir)).filter((file) => file.endsWith(".json"));
      const rows: SessionSummary[] = [];
      for (const file of files) {
        try {
          const session = JSON.parse(await fsp.readFile(`${sessionDir}/${file}`, "utf8")) as Partial<Core.Session>;
          if (!session.id) continue;
          rows.push({ id: session.id, title: session.title || session.id.slice(0, 8), created: session.created ?? "" });
        } catch {}
      }
      return rows.sort((a, b) => b.created.localeCompare(a.created));
    } catch {
      return [];
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    return (await this.readSessions()).slice(0, 12);
  }

  async openSession(idPrefix: string): Promise<string> {
    const sessions = await this.readSessions();
    const match = sessions.find((session) => session.id.startsWith(idPrefix));
    if (!match) throw new Error(`找不到会话 ${idPrefix}`);
    this.currentSessionId = match.id;
    return match.id;
  }

  async run(input: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    if (!this.agent) throw new Error("Agent 尚未初始化");
    onEvent({ type: "thinking", message: "Preparing context..." });
    await this.sessionStore.addMessage(this.currentSessionId, { role: "user", content: input });
    let assistantText = "";
    for await (const event of this.agent.run(input, this.currentSessionId)) {
      if (event.type === "text_chunk") assistantText += event.text;
      onEvent(event);
      if (event.type === "done") {
        const finalText = (event.finalText || assistantText).trim();
        if (finalText) {
          await this.sessionStore.addMessage(this.currentSessionId, { role: "assistant", content: finalText });
        }
      }
    }
  }

  abort(): void {
    this.agent?.abort();
  }

  async steer(input: string): Promise<void> {
    if (!this.agent || !this.currentSessionId) throw new Error("Agent 尚未初始化");
    await this.sessionStore.addMessage(this.currentSessionId, {
      role: "user",
      content: input,
      name: "__steer__",
    });
  }

  async switchProject(nextDirectory: string): Promise<RuntimeSnapshot> {
    const resolved = await fsp.realpath(nextDirectory);
    const built = await this.agentFactory(resolved, this.model, (request) => this.questionHandler(request));
    this.workingDirectory = resolved;
    this.agent = built.agent;
    this.skillsCache = built.skills;
    process.chdir(resolved);
    process.stdout.write(`\x1b]7;${pathToFileURL(resolved).href}\x07`);
    await this.newSession();
    return this.snapshot();
  }

  async switchModel(nextModel: ModelSelection): Promise<RuntimeSnapshot> {
    const built = await this.agentFactory(this.workingDirectory, nextModel, (request) => this.questionHandler(request));
    this.model = nextModel;
    this.agent = built.agent;
    this.skillsCache = built.skills;
    await this.newSession();
    return this.snapshot();
  }
}
