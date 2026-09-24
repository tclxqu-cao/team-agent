export interface ChatSubmission {
  text: string;
  origin: "composer" | "suggestion";
  applyGoalMode: boolean;
  clearComposer: boolean;
  restoreDraftOnFailure: boolean;
  agentIds?: string[];
  agentName?: string;
  images?: string[];
}

export interface ComposerSubmissionInput {
  text: string;
  agentIds?: string[];
  agentName?: string;
  images?: string[];
}

function cloneNonEmpty(values: string[] | undefined): string[] | undefined {
  return values?.length ? [...values] : undefined;
}

export function createComposerSubmission(input: ComposerSubmissionInput): ChatSubmission {
  const agentIds = cloneNonEmpty(input.agentIds);
  const images = cloneNonEmpty(input.images);
  return {
    text: input.text.trim(),
    origin: "composer",
    applyGoalMode: true,
    clearComposer: true,
    restoreDraftOnFailure: true,
    ...(agentIds ? { agentIds } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(images ? { images } : {}),
  };
}

export function createSuggestionSubmission(command: string): ChatSubmission {
  return {
    text: command.trim(),
    origin: "suggestion",
    applyGoalMode: false,
    clearComposer: false,
    restoreDraftOnFailure: false,
  };
}
