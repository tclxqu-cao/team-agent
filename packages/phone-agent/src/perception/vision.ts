import type { PhoneAgentConfig } from "../config.js";

export interface VisionAnnotator {
  annotate(png: Uint8Array, question: string): Promise<string>;
  readonly enabled: boolean;
}

/**
 * 可选视觉描述：配置了 OpenAI 兼容模型（PHONE_VISION_*）时，
 * 用它把截图转成文字，弥补无障碍树丢失的图像信息（图片、促销贴图、非原生控件）。
 * CA agent 的工具结果通道是纯文本（ToolResult.content），所以感知结果统一转文字回传。
 */
export function createVisionAnnotator(config: PhoneAgentConfig): VisionAnnotator {
  const enabled = Boolean(config.visionBaseUrl && config.visionApiKey && config.visionModel);
  return {
    enabled,
    async annotate(png: Uint8Array, question: string): Promise<string> {
      if (!enabled) {
        return "";
      }
      const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
      const url = `${config.visionBaseUrl.replace(/\/$/, "")}/chat/completions`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.visionApiKey}`,
        },
        body: JSON.stringify({
          model: config.visionModel,
          max_tokens: 800,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    `这是一张手机屏幕截图。请用简洁中文描述屏幕上与下面问题相关的关键信息` +
                    `（可见文字、价格、按钮位置）。问题：${question || "屏幕上有什么？"}`,
                },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) {
        throw new Error(`视觉模型调用失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      }
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content?.trim() ?? "";
    },
  };
}
