import React from "react";
import { Box, Text } from "ink";
import type { ModelWizardState } from "../model-wizard.js";
import { wizardStepNumber } from "../model-wizard.js";
import { ROLE_GLYPHS, TUI_THEME } from "../theme.js";

const STEPS = ["服务地址", "API Key", "默认模型"] as const;

export function ModelWizard({ state }: { state: ModelWizardState }) {
  const current = wizardStepNumber(state);
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box>
        <Box width={3} flexShrink={0}>
          <Text color={TUI_THEME.spark} bold>{ROLE_GLYPHS.setup}</Text>
        </Box>
        <Text color={TUI_THEME.faint}>│ </Text>
        <Text color={TUI_THEME.strong} bold>模型服务</Text>
        {state.step === "fetching" ? <Text color={TUI_THEME.progress}>  ● 正在获取模型</Text> : null}
      </Box>
      <Box paddingLeft={4}>
        {STEPS.map((label, index) => {
          const number = index + 1;
          const active = number === current;
          const complete = number < current;
          return (
            <Text key={label} color={active ? TUI_THEME.active : complete ? TUI_THEME.ready : TUI_THEME.muted} bold={active}>
              {complete ? "✓" : number} {label}{number < STEPS.length ? "   " : ""}
            </Text>
          );
        })}
      </Box>
      {state.step !== "url" ? (
        <Box paddingLeft={4}>
          <Text color={TUI_THEME.muted} wrap="truncate">{state.endpoint.modelsUrl}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
