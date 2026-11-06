import type { MessagingModel } from "@agent/messaging";
import { ModelRegistry } from "@agent/core";
import type { ProviderType } from "../../../core/src/domain/model/ModelRegistry";
import { sharedSettings } from "../shared-settings";

export function messagingModel(): MessagingModel {
  const settings = sharedSettings().read();
  const profile = settings.profiles.find(item => item.id === settings.activeProfileId);
  const config = profile ?? settings;
  const providerType = profile?.provider ?? settings.modelProvider;
  if (!config.modelId) throw new Error("请先配置系统模型，用于判断和回复消息");
  const provider = new ModelRegistry().createAndRegister(providerType as ProviderType, {
    modelId: config.modelId, apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs: 45_000, maxTokens: null,
  });
  return { provider, model: providerType + "/" + config.modelId };
}
