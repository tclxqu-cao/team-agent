export interface PrepareChatCommandOptions {
  text: string;
  projectId: string | null;
  sessionId: string | null;
  createSession: (title: string, projectId?: string) => Promise<{ id: string }>;
  activateSession: (sessionId: string) => void;
  showUserMessage: (text: string, sessionId: string) => void;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
}

export async function prepareChatCommand(options: PrepareChatCommandOptions): Promise<string> {
  const existingSessionId = options.sessionId?.trim() || null;
  const isNewSession = !existingSessionId;
  const targetSessionId = existingSessionId
    ?? (await options.createSession(
      options.text.slice(0, 60) || "New Session",
      options.projectId || undefined,
    )).id.trim();

  if (!targetSessionId) {
    throw new Error("创建会话失败：服务端未返回会话 ID");
  }

  options.activateSession(targetSessionId);
  options.showUserMessage(options.text, targetSessionId);
  if (isNewSession) await options.onSessionCreated?.(targetSessionId);
  return targetSessionId;
}
