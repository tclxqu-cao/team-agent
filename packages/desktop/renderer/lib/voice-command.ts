export interface PrepareVoiceCommandOptions {
  text: string;
  projectId: string | null;
  sessionId?: string | null;
  createSession: (title: string, projectId?: string) => Promise<{ id: string }>;
  activateSession: (sessionId: string) => void;
  showUserMessage: (text: string, sessionId: string) => void;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
  isCancelled?: () => boolean;
}

export function shouldSkipVoiceSessionReload(
  runningSessionId: string | null,
  activeSessionId: string | null,
  targetSessionId: string | null,
): boolean {
  if (!runningSessionId || activeSessionId !== runningSessionId) return false;
  return targetSessionId === null || targetSessionId === runningSessionId;
}

export function renewVoiceConversation(
  conversation: { sessionId: string; until: number } | null,
  completedSessionId: string,
  now = Date.now(),
): { sessionId: string; until: number } | null {
  if (!conversation || conversation.sessionId !== completedSessionId) return conversation;
  return { ...conversation, until: now + 90_000 };
}

export async function prepareVoiceCommand(
  options: PrepareVoiceCommandOptions,
): Promise<string | null> {
  const {
    text,
    projectId,
    createSession,
    activateSession,
    showUserMessage,
    onSessionCreated,
    isCancelled,
  } = options;
  const isNewSession = !options.sessionId;
  let targetSessionId = options.sessionId ?? null;

  if (!targetSessionId) {
    const created = await createSession(text.slice(0, 60) || "语音任务", projectId || undefined);
    if (isCancelled?.()) return null;
    targetSessionId = created.id;
  }

  activateSession(targetSessionId);
  showUserMessage(text, targetSessionId);
  if (isNewSession && onSessionCreated) await onSessionCreated(targetSessionId);
  return targetSessionId;
}
