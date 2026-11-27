import type { IModelProvider, ModelProviderConfig } from '../domain/model/entities.js';
export type ProviderType = "anthropic" | "openai" | "deepseek" | "aihub";
export declare class ModelRegistry {
    private readonly providers;
    register(provider: IModelProvider): void;
    get(providerId: string): IModelProvider | undefined;
    createAndRegister(type: ProviderType, config: ModelProviderConfig): IModelProvider;
    listProviders(): IModelProvider[];
    findForModel(modelId: string): IModelProvider | undefined;
}
//# sourceMappingURL=ModelRegistry.d.ts.map