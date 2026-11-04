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
    text: input.text.trim() || (images ? "请查看图片。" : ""),
    origin: "composer",
    applyGoalMode: true,
    clearComposer: true,
    restoreDraftOnFailure: true,
    ...(agentIds ? { agentIds } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(images ? { images } : {}),
  };
}

/** A failed send must not replace anything composed while admission was pending. */
export function restoreFailedComposerDraft(
  current: { text: string; images: string[] },
  failed: { content: string; images?: string[] },
): { text: string; images: string[] } {
  return {
    text: !current.text ? failed.content
      : current.text === failed.content || current.text.startsWith(`${failed.content}\n\n`) ? current.text
      : `${failed.content}\n\n${current.text}`,
    images: [...new Set([...(failed.images ?? []), ...current.images])],
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
