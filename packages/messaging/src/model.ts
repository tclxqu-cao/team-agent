import type { IModelProvider } from "@agent/core";

export interface MessagingModel { provider: Pick<IModelProvider, "streamChat">; model: string; }
export type MessagingModelFactory = () => MessagingModel;

/** A failed model request or invalid response is not a business confirmation. */
export class MessagingModelError extends Error {
  constructor(message: string) { super(message); this.name = "MessagingModelError"; }
}

export async function modelJson<T>(createModel: MessagingModelFactory, system: string, input: unknown): Promise<{ value: T; model: string }> {
  try {
    const { provider, model } = createModel();
    let text = "";
    for await (const event of provider.streamChat([
      { role: "system", content: system }, { role: "user", content: JSON.stringify(input) },
    ], { temperature: 0 })) {
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "text_chunk") text += event.text;
    }
    return { value: JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")) as T, model };
  } catch (error) {
    throw new MessagingModelError(error instanceof Error ? error.message : "消息模型调用失败");
  }
}
