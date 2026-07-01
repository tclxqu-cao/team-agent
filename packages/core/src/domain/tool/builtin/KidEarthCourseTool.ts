import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from "../entities.js";

const chapterSchema = z.object({
  sortOrder: z.number().int().nonnegative(),
  title: z.string().min(1),
  shortTitle: z.string().min(1),
  icon: z.string().min(1),
  sceneKey: z.enum(["helloEarth", "ocean", "land", "mountain", "airplane", "city", "rotation", "moon", "revolution", "home"]),
  narration: z.string().min(1),
  tapPrompt: z.string().min(1),
  guide: z.string().min(1),
  questionTitle: z.string().min(1),
  questionText: z.string().min(1),
  choices: z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]),
  answerIndex: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  feedback: z.string().min(1),
  funFact: z.string().min(1),
  parentPrompt: z.string().min(1),
});

const schema = z.object({
  title: z.string().min(1).describe("课程标题，例如：揭秘太阳"),
  slug: z.string().min(1).optional().describe("课程 slug；不传则由 kid-earth 自动生成"),
  ageRange: z.string().default("4 岁").describe("年龄范围"),
  publish: z.boolean().default(true).describe("是否创建后立即发布到 C 端"),
  chapters: z.array(chapterSchema).min(1).describe("课程章节列表"),
});

type Input = z.infer<typeof schema>;

export class KidEarthCourseTool implements ITool {
  readonly name = "kid_earth_create_course";
  readonly description = "Create a Kid Earth Learning course, add chapters, and optionally publish it to the learner-facing page. Use this when the user asks to create or generate a course.";
  readonly schema = schema;
  readonly parameters = {
    type: "object",
    properties: {
      title: { type: "string", description: "课程标题，例如：揭秘太阳" },
      slug: { type: "string", description: "课程 slug；可省略，建议用英文或拼音短横线" },
      ageRange: { type: "string", description: "年龄范围，例如：4 岁" },
      publish: { type: "boolean", description: "是否创建后立即发布" },
      chapters: {
        type: "array",
        description: "课程章节列表，建议 4-8 章；每章一个现象、一个问题、三个图标选项",
        items: {
          type: "object",
          properties: {
            sortOrder: { type: "number", description: "从 0 开始的排序" },
            title: { type: "string" },
            shortTitle: { type: "string" },
            icon: { type: "string", description: "emoji 图标" },
            sceneKey: { type: "string", enum: ["helloEarth", "ocean", "land", "mountain", "airplane", "city", "rotation", "moon", "revolution", "home"] },
            narration: { type: "string", description: "适合 4 岁儿童听的旁白" },
            tapPrompt: { type: "string" },
            guide: { type: "string" },
            questionTitle: { type: "string" },
            questionText: { type: "string" },
            choices: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
            answerIndex: { type: "number", enum: [0, 1, 2] },
            feedback: { type: "string" },
            funFact: { type: "string" },
            parentPrompt: { type: "string" },
          },
          required: ["sortOrder", "title", "shortTitle", "icon", "sceneKey", "narration", "tapPrompt", "guide", "questionTitle", "questionText", "choices", "answerIndex", "feedback", "funFact", "parentPrompt"],
        },
      },
    },
    required: ["title", "chapters"],
  };

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid parameters: ${parsed.error.message}`, isError: true };
    }

    try {
      const data = parsed.data;
      const baseUrl = (process.env.KID_EARTH_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
      const cookie = await this.login(baseUrl);
      const courseId = await this.createCourse(baseUrl, cookie, data.title);
      await this.updateCourse(baseUrl, cookie, courseId, data);
      const chapterIds = await this.addChapters(baseUrl, cookie, courseId, data.chapters);
      const published = data.publish ? await this.publishCourse(baseUrl, cookie, courseId) : null;

      return {
        toolCallId: "",
        content: `课程已创建：${data.title}（ID ${courseId}）。已保存 ${chapterIds.length} 个章节${published ? "，并已发布到 C 端" : ""}。`,
      };
    } catch (error) {
      return { toolCallId: "", content: error instanceof Error ? error.message : "Kid Earth course creation failed", isError: true };
    }
  }

  private async login(baseUrl: string): Promise<string> {
    const username = process.env.KID_EARTH_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "admin";
    const password = process.env.KID_EARTH_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "change-me-before-deploy";
    const response = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) throw new Error(`Kid Earth login failed: ${response.status}`);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Kid Earth login did not return a session cookie");
    return cookie;
  }

  private async createCourse(baseUrl: string, cookie: string, title: string): Promise<number> {
    const response = await fetch(`${baseUrl}/api/admin/courses`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title }),
    });
    const body = await this.readJson(response);
    if (!response.ok || typeof body.id !== "number") throw new Error(`Kid Earth create course failed: ${response.status} ${JSON.stringify(body)}`);
    return body.id;
  }

  private async updateCourse(baseUrl: string, cookie: string, courseId: number, data: Input): Promise<void> {
    const response = await fetch(`${baseUrl}/api/admin/courses/${courseId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: data.title, slug: data.slug ?? this.slugify(data.title), ageRange: data.ageRange, status: "draft" }),
    });
    if (!response.ok) throw new Error(`Kid Earth update course failed: ${response.status} ${JSON.stringify(await this.readJson(response))}`);
  }

  private async addChapters(baseUrl: string, cookie: string, courseId: number, chapters: Input["chapters"]): Promise<number[]> {
    const response = await fetch(`${baseUrl}/api/admin/courses/${courseId}/ai/chapters`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ chapters }),
    });
    const body = await this.readJson(response);
    if (!response.ok || !Array.isArray(body.ids)) throw new Error(`Kid Earth add chapters failed: ${response.status} ${JSON.stringify(body)}`);
    return body.ids as number[];
  }

  private async publishCourse(baseUrl: string, cookie: string, courseId: number): Promise<unknown> {
    const response = await fetch(`${baseUrl}/api/admin/courses/${courseId}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    const body = await this.readJson(response);
    if (!response.ok) throw new Error(`Kid Earth publish course failed: ${response.status} ${JSON.stringify(body)}`);
    return body;
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    const data = await response.json().catch(() => ({}));
    return data && typeof data === "object" ? data as Record<string, unknown> : {};
  }

  private slugify(title: string): string {
    return title.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9一-龥-]/g, "").slice(0, 64) || `course-${Date.now()}`;
  }
}
