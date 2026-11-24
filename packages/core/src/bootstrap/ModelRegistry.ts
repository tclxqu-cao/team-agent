import type { IModelProvider, ModelProviderConfig } from '../domain/model/entities.js';
import { AnthropicProvider } from '../infrastructure/models/AnthropicProvider.js';
import { OpenAIProvider } from '../infrastructure/models/OpenAIProvider.js';
import { DeepSeekProvider } from '../infrastructure/models/DeepSeekProvider.js';
import { AiHubProvider } from '../infrastructure/models/AiHubProvider.js';

export type ProviderType = "anthropic" | "openai" | "deepseek" | "aihub";

export class ModelRegistry {
  private readonly providers = new Map<string, IModelProvider>();

  register(provider: IModelProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  get(providerId: string): IModelProvider | undefined {
    return this.providers.get(providerId);
  }

  createAndRegister(type: ProviderType, config: ModelProviderConfig): IModelProvider {
    let provider: IModelProvider;
    switch (type) {
      case "anthropic":
        provider = new AnthropicProvider(config);
        break;
      case "openai":
        provider = new OpenAIProvider(config);
        break;
      case "deepseek":
        provider = new DeepSeekProvider(config);
        break;
      case "aihub":
        provider = new AiHubProvider(config);
        break;
      default:
        throw new Error(`Unknown provider type: ${type}`);
    }
    this.register(provider);
    return provider;
  }

  listProviders(): IModelProvider[] {
    return Array.from(this.providers.values());
  }

  findForModel(modelId: string): IModelProvider | undefined {
    for (const p of this.providers.values()) {
      if (p.supportsModel(modelId)) return p;
    }
    return undefined;
  }
}
