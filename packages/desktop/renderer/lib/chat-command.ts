export interface PrepareChatCommandOptions<Session extends { id: string } = { id: string }> {
  text: string;
  projectId: string | null;
  sessionId: string | null;
  createSession: (title: string, projectId?: string) => Promise<Session>;
  activateSession: (sessionId: string) => void;
  showUserMessage: (text: string, sessionId: string) => void;
  afterUserMessageShown?: () => void | Promise<void>;
  onSessionCreated?: (sessionId: string, session?: Session) => void | Promise<void>;
}

export async function prepareChatCommand<Session extends { id: string }>(options: PrepareChatCommandOptions<Session>): Promise<string> {
  const existingSessionId = options.sessionId?.trim() || null;
  const isNewSession = !existingSessionId;
  const createdSession = isNewSession
    ? await options.createSession(
      options.text.slice(0, 60) || "New Session",
      options.projectId || undefined,
    ) : undefined;
  const targetSessionId = existingSessionId ?? createdSession?.id.trim();

  if (!targetSessionId) {
    throw new Error("创建会话失败：服务端未返回会话 ID");
  }

  options.activateSession(targetSessionId);
  options.showUserMessage(options.text, targetSessionId);
  await options.afterUserMessageShown?.();
  if (isNewSession) await options.onSessionCreated?.(targetSessionId, createdSession);
  return targetSessionId;
}
