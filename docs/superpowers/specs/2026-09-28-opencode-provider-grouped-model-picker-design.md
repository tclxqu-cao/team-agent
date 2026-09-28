# OpenCode Provider-Grouped Model Picker Design

## Goal

Group provider-scoped OpenCode models in the Desktop composer without changing Codex, Claude Code, persisted model keys, or runtime request routing.

## Design

The OpenCode adapter will preserve each provider's display name from `config.providers` as optional `providerDisplayName` metadata on `RuntimeModelInfo`. The renderer will group runtime models by `providerID` using native `<optgroup>` elements, preserving server order.

Each OpenCode option displays only the model name because its parent `<optgroup>` already identifies the provider. The `OpenCode Go` group label will include `（需订阅）` because zero model cost does not remove the provider's subscription gate.

Settings-defined model profiles remain under the existing `设置里的模型` group. Codex and Claude Code continue rendering their flat runtime model lists.

## Data Flow

1. `OpenCodeRuntimeAdapter.listModels()` reads provider ID, provider name, model ID, and model name.
2. The existing Broker/API/IPC path transports the additional optional field unchanged.
3. A pure renderer helper creates ordered OpenCode provider groups and model-only option labels.
4. Selection still decodes to the existing `{ providerID, id }` value and `promptAsync` still sends the same provider-scoped model.

## Error Handling

Missing provider names fall back to `providerID`; missing provider IDs fall back to `其他供应商`. The model ID remains the stable value, so presentation metadata cannot change routing.

## Verification

- Adapter test proves provider display names survive catalog flattening.
- Renderer helper tests prove Zen/Go separation, subscription copy, model-only labels, fallback behavior, and stable provider order.
- Existing native preference tests prove provider-scoped selection keys remain unchanged.
- Desktop TypeScript and focused Vitest suites must pass.
