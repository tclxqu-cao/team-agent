# Unlimited Maximum Iterations Design

## Goal

Allow the Customer Agent general setting for maximum iterations to be edited naturally and support `0` as unlimited.

## Behavior

- The settings input may be temporarily empty while editing.
- Save rejects an empty value, non-integers, and negative integers.
- `0` means the Customer Agent loop has no iteration limit.
- Positive integers have no product-defined upper bound.
- Existing defaults remain `10` when the setting is absent or invalid persisted legacy data is read.
- Abort, model completion, errors, and other existing terminal paths still stop an unlimited run.

## Implementation

Keep an input draft string in `SettingsPanel` and write the parsed number to the settings store only after save validation. Preserve `0` through the WebApp local settings adapter, shared settings API, and run-option normalization. In `AgentLoop`, centralize the limit check so a non-positive configured limit is treated as unlimited.

## Verification

Cover empty/save validation where practical, configuration normalization for `0` and large positive values, shared settings validation, and loop behavior beyond the former cap. Run focused tests, TypeScript checks, and a WebApp production build.
