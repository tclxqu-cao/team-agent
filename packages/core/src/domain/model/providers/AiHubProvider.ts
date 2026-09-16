// AI Hub 网页模型来源（输入/输出适配层）：把 AgentLoop 的标准模型调用
// 适配成「桌面 AI Hub 注入发送（模拟人为）→ 抓取站点新回复」的两步。
// 上下文（系统提示 + 历史 + 最新用户消息）被拍平成一段文本整体发送，
// 抓取侧用发送文本携带的唯一锚点定位本轮新增消息，只把新 assistant
// 回吐给 AgentLoop。工具调用通过提示词约定的 JSON 信封转换成标准 tool_call。
import type { IModelProvider, Message, StreamEvent, StreamOptions, ModelProviderConfig, ToolCall, ToolDefinition } from '../entities.js';
import { MAX_RELAY_TEXT_LENGTH } from '../../ai-hub/relay-protocol.js';
import type { AiHubCaptureMessage, AiHubTransport } from '../../ai-hub/transport.js';
import { AiHubSocketTransport } from '../../../infrastructure/AiHubSocketTransport.js';

// 连续 N 次轮询抓到相同文本视为网页生成结束（站点回复是渐进渲染的）
const STABLE_POLLS = 2;
const POLL_INTERVAL_MS = 2000;
const MIN_SETTLE_MS = 8000;
const DEFAULT_TIMEOUT_MS = 240_000;
// 网页出现「继续生成」按钮时的自动续跑：最多点 N 次，两次点击之间至少间隔 M 毫秒
const MAX_CONTINUE_ATTEMPTS = 5;
const CONTINUE_RETRY_MS = 6000;
// 锚点只取头部一小段即可稳定命中；抓取侧保留完整增长文本来判断完成态。
const ANCHOR_MATCH_CHARS = 80;
// 回吐给 AgentLoop 时的分片大小，避免一次性巨块
const CHUNK_CHARS = 1200;
const AI_HUB_RELAY_STATE = new Map<string, { messageCount: number; toolSignature: string }>();

export function composeAiHubTranscript(
  messages: Message[],
  anchor: string,
  tools: ToolDefinition[] = [],
  workingDirectory?: string,
  includeToolProtocol = true,
): string {
  const anchorLine = `【Agent 转发 · ${anchor}】`;
  const systemParts: string[] = [];
  const historyLines: string[] = [];
  let hasFailedToolResult = false;
  const latestIndex = findLastIndex(messages, (message) => message.role === 'user' && Boolean(messageText(message)));
  for (const [index, message] of messages.entries()) {
    const text = messageText(message);
    if (!text && !message.toolCalls?.length && message.role !== 'tool') continue;
    if (message.role === 'system') systemParts.push(text);
    else if (message.role === 'user' && index !== latestIndex) historyLines.push(`用户：${text}`);
    else if (message.role === 'assistant') {
      if (text) historyLines.push(`助手：${text}`);
      for (const call of message.toolCalls ?? []) {
        historyLines.push(`助手调用工具（call_id=${call.id}）：${call.name}\n参数：${JSON.stringify(call.arguments)}`);
      }
    } else {
      // 网页模型看不到结构化的 isError：失败结果必须显式标注，否则 stderr
      // 会被当成普通输出无视，工具调用就无法自修复。
      const failed = message.role === 'tool' && message.isError === true;
      if (failed) hasFailedToolResult = true;
      historyLines.push(`工具结果（name=${message.name ?? 'unknown'}, call_id=${message.toolCallId ?? 'unknown'}, 状态=${failed ? '失败' : '成功'}）：${text}`);
    }
  }
  // 最新一条用户消息单独成段，站点模型无需再从历史里猜本轮要答什么
  const latest = latestIndex >= 0 ? messageText(messages[latestIndex]) : '';
  const prefixSections: string[] = [
    `${anchorLine}`,
    '以下是一段完整对话的背景与历史。请理解上下文后，以「助手」的身份直接回答最后的用户消息。',
  ];
  if (workingDirectory) prefixSections.push(`【当前项目目录】\n${workingDirectory}`);
  if (tools.length > 0 && includeToolProtocol) prefixSections.push(composeToolProtocol(tools));
  const suffixSections = [
    ...(latest ? [`【用户最新消息】\n${latest}`] : []),
    tools.length > 0
    ? includeToolProtocol
      ? '（需要工具时只输出工具调用 JSON；不需要工具时直接输出最终回复。不要复述以上设定。）'
      : '（可继续使用本网页会话此前提供的工具协议。需要工具时只输出工具调用 JSON；否则直接回复。）'
    : '（请直接输出对最新用户消息的回复内容，不要复述以上设定。）',
    ...(hasFailedToolResult
      ? ['【工具执行失败】上面的工具结果中存在「状态=失败」的条目。请先阅读其中的错误信息，修正调用参数或改用其他工具/方案后重新调用；不要无视失败结果直接给出最终回复。']
      : []),
  ];
  const required = [...prefixSections, ...suffixSections].join('\n\n');
  if (required.length > MAX_RELAY_TEXT_LENGTH) {
    throw new Error(`AI Hub 固定上下文超过 ${MAX_RELAY_TEXT_LENGTH} 字符：项目目录、工具定义和最新消息不能截断`);
  }

  const optionalSections: string[] = [];
  if (systemParts.length > 0) optionalSections.push(`【系统设定】\n${systemParts.join('\n\n')}`);
  if (historyLines.length > 0) optionalSections.push(`【对话历史】\n${historyLines.join('\n\n')}`);
  const optional = optionalSections.join('\n\n');
  const separatorCost = optional ? 2 : 0;
  const optionalBudget = MAX_RELAY_TEXT_LENGTH - required.length - separatorCost;
  const compactedMarker = '【历史上下文已按 CA 规则压缩】\n';
  const optionalTailBudget = Math.max(0, optionalBudget - compactedMarker.length);
  const fittedOptional = optional.length > optionalBudget
    ? (optionalBudget >= compactedMarker.length
      ? `${compactedMarker}${optionalTailBudget > 0 ? optional.slice(-optionalTailBudget) : ''}`
      : '')
    : optional;
  return [...prefixSections, ...(fittedOptional ? [fittedOptional] : []), ...suffixSections].join('\n\n');
}

export class AiHubProvider implements IModelProvider {
  readonly providerId = 'aihub';
  /** AI Hub 站点 ID（如 deepseek / chatgpt / 自定义站点） */
  readonly modelId: string;
  private readonly transport: AiHubTransport;
  private readonly timeoutMs: number;

  constructor(config: ModelProviderConfig) {
    this.modelId = config.modelId;
    this.transport = config.transport ?? new AiHubSocketTransport();
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async *streamChat(messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent> {
    const siteId = this.modelId;
    const status = await this.transport.status();
    if (!status.available) {
      yield { type: 'error', message: 'AI Hub 桌面端离线：请启动 AgentRoam 桌面 App 后重试' };
      return;
    }
    // Some sites do not expose the injected user bubble to DOM extraction.
    // Keep a pre-send assistant baseline so a newly captured reply can still
    // be attributed to this request when the anchor itself is unavailable.
    const conversationId = options?.sessionId;
    const baseline = await this.captureSite(siteId, conversationId);
    const baselineMessages = baseline?.messages ?? [];
    const baselineAssistantTexts = baselineMessages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.text);
    const anchor = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const tools = options?.tools ?? [];
    const relayKey = `${siteId}\u0000${conversationId ?? "default"}`;
    const previous = AI_HUB_RELAY_STATE.get(relayKey);
    const toolSignature = JSON.stringify(tools);
    const includeToolProtocol = baselineMessages.length === 0 || previous?.toolSignature !== toolSignature;
    const relayMessages = selectAiHubRelayMessages(messages, baselineMessages.length > 0, previous?.messageCount);
    let transcript: string;
    try {
      transcript = composeAiHubTranscript(relayMessages, anchor, tools, options?.workingDirectory, includeToolProtocol);
    } catch (error) {
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
      return;
    }
    const images = latestUserImages(messages);
    const broadcast = await this.transport.broadcast(transcript, [siteId], images, conversationId);
    const result = broadcast.results.find((entry) => entry.siteId === siteId);
    if (!result?.ok) {
      const reason = result?.reason || broadcast.reason || 'unknown';
      yield { type: 'error', message: `AI Hub 发送失败（${siteId}）：${reason}` };
      return;
    }
    AI_HUB_RELAY_STATE.set(relayKey, { messageCount: messages.length, toolSignature });

    const anchorHead = transcript.slice(0, ANCHOR_MATCH_CHARS);
    const initialDeadline = Date.now() + this.timeoutMs;
    let deadline = initialDeadline;
    const notBefore = Date.now() + Math.min(MIN_SETTLE_MS, Math.max(0, this.timeoutMs - POLL_INTERVAL_MS));
    let reply = '';
    let stableCount = 0;
    let continueAttempts = 0;
    let lastContinueAt = 0;
    let pendingContinue = false;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const entry = await this.captureSite(siteId, conversationId);
      if (!entry) continue;
      pendingContinue = entry.pendingContinue;
      // 站点可能把长回复截断并挂出「继续生成」按钮：此时文本稳定不代表生成结束，
      // 必须先点击续跑，否则半截回复会被当成最终答案结束本轮。
      const shouldResume = entry.pendingContinue
        && continueAttempts < MAX_CONTINUE_ATTEMPTS
        && Date.now() >= notBefore
        && Date.now() - lastContinueAt >= CONTINUE_RETRY_MS;
      const candidate = extractReplyAfterAnchor(entry.messages, anchorHead)
        || extractReplyAfterBaseline(entry.messages, baselineAssistantTexts);
      if (!candidate) {
        if (entry.pendingContinue
          && continueAttempts >= MAX_CONTINUE_ATTEMPTS
          && Date.now() - lastContinueAt >= CONTINUE_RETRY_MS) {
          yield { type: 'error', message: this.continueLimitError(siteId) };
          return;
        }
        if (shouldResume) {
          continueAttempts += 1;
          lastContinueAt = Date.now();
          await this.tryContinue(siteId, conversationId);
        }
        continue;
      }
      if (candidate === reply) {
        stableCount += 1;
        if (stableCount >= STABLE_POLLS && Date.now() >= notBefore) {
          if (entry.pendingContinue
            && continueAttempts >= MAX_CONTINUE_ATTEMPTS
            && Date.now() - lastContinueAt >= CONTINUE_RETRY_MS) {
            yield { type: 'error', message: this.continueLimitError(siteId) };
            return;
          }
          if (shouldResume) {
            continueAttempts += 1;
            lastContinueAt = Date.now();
            stableCount = 0;
            if (await this.tryContinue(siteId, conversationId)) {
              // 续跑后网页继续产出：适度延长等待，总量不超过 2 倍单轮超时
              deadline = Math.min(deadline + this.timeoutMs / 2, initialDeadline + this.timeoutMs);
            }
            continue;
          }
          if (entry.pendingContinue) continue;
          yield* emitReply(reply, tools);
          return;
        }
      } else {
        reply = candidate;
        stableCount = 1;
      }
    }
    if (reply) {
      if (pendingContinue) {
        yield { type: 'error', message: this.continueLimitError(siteId) };
        return;
      }
      // 超时兜底：宁可回吐已抓到的部分，也不让这一轮凭空失败
      yield* emitReply(reply, tools);
      return;
    }
    yield { type: 'error', message: `AI Hub 抓取回复超时（${Math.round(this.timeoutMs / 1000)}s，${siteId}）：站点可能未登录、被限流或选择器漂移，请打开桌面 App AI Hub 面板确认` };
  }

  async countTokens(messages: Message[]): Promise<number> {
    return messages.reduce((sum, message) => sum + Math.ceil(messageText(message).length / 4), 0);
  }

  supportsModel(_modelId: string): boolean {
    return true; // modelId 即 AI Hub 站点 ID，接受任意已配置站点
  }

  private async captureSite(siteId: string, conversationId?: string): Promise<{ messages: AiHubCaptureMessage[]; pendingContinue: boolean } | null> {
    const capture = await this.transport.capture([siteId], conversationId);
    const entry = capture.results.find((candidate) => candidate.siteId === siteId);
    if (!entry?.ok || !entry.messages || entry.messages.length === 0) return null;
    return {
      messages: entry.messages.map((message) => ({
        ...message,
        text: stripCapturedCodeToolbar(message.text),
      })),
      pendingContinue: entry.pendingContinue === true,
    };
  }

  /** 请桌面端点击站点上的「继续生成」控件；返回是否确认点击成功。 */
  private async tryContinue(siteId: string, conversationId?: string): Promise<boolean> {
    try {
      const result = await this.transport.continueGeneration([siteId], conversationId);
      return result.results.find((entry) => entry.siteId === siteId)?.ok === true;
    } catch {
      return false;
    }
  }

  private continueLimitError(siteId: string): string {
    return `AI Hub 回复仍处于截断状态（${siteId}）：已尝试 ${MAX_CONTINUE_ATTEMPTS} 次“继续生成”，未确认完整回复。请打开 AI Hub 页面检查，半截内容未作为最终答案提交。`;
  }
}

/**
 * AI Hub pages already retain their own conversation. Bootstrap an empty page
 * with full CA context, then send only the new user turn or current tool-loop
 * delta so prior history is not nested again on every request.
 */
export function selectAiHubRelayMessages(
  messages: Message[],
  pageHasHistory: boolean,
  previousMessageCount?: number,
): Message[] {
  if (!pageHasHistory) return messages;
  if (previousMessageCount !== undefined && previousMessageCount <= messages.length) {
    const delta = messages.slice(previousMessageCount);
    const latestUserInDelta = findLastIndex(delta, (message) => message.role === "user");
    if (latestUserInDelta >= 0) return delta.slice(latestUserInDelta);
    if (delta.length > 0) return delta;
  }
  const latestUser = findLastIndex(messages, (message) => message.role === "user");
  return latestUser >= 0 ? [messages[latestUser]] : messages.slice(-1);
}

/** Remove code-block chrome exposed by webpage innerText (language / copy / download). */
export function stripCapturedCodeToolbar(text: string): string {
  return text.replace(
    /(^|\n)(?:[a-z][\w+#.-]{0,20}\n)?(?:复制|copy)\n(?:下载|download)(?:\n|$)/gi,
    "$1",
  );
}

function composeToolProtocol(tools: ToolDefinition[]): string {
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return `【可用工具与调用协议】
你可以调用且只能调用下列工具：
${JSON.stringify(definitions, null, 2)}

需要调用工具时，只能输出一个 JSON 对象，不要使用 Markdown 代码块，也不要附加解释：
{"type":"tool_call","id":"call_<唯一标识>","name":"工具名","arguments":{"参数名":"参数值"}}
arguments 必须是 JSON 对象并符合该工具的 parameters。每次只能调用一个工具。工具执行结果会在下一轮对话中提供，并标注「状态=成功/失败」；收到「状态=失败」的结果时，必须阅读其中的错误信息，修正参数后重新调用或改用其他工具，不要无视失败直接作答。
如果对话历史中已经有能回答当前问题的成功工具结果，必须直接基于该结果回答，不要重复调用同一个工具；只有结果报错或确实缺少必要信息时才能再次调用。`;
}

export function parseAiHubToolCall(reply: string, tools: ToolDefinition[]): ToolCall | null {
  if (tools.length === 0) return null;
  const trimmed = reply.trim();
  const jsonText = unwrapJsonFence(trimmed);
  const jsonValue = parseToolCallEnvelope(jsonText);
  const value = jsonValue ?? parseDsmlToolCall(jsonText);
  if (value === null) {
    if (/"type"\s*:\s*"tool_call"/.test(jsonText)) {
      throw new Error('AI Hub 返回的工具调用 JSON 格式无效');
    }
    if (jsonText.includes('｜｜DSML｜｜')) {
      throw new Error('AI Hub 返回的 DSML 工具调用格式无效');
    }
    return null;
  }
  if (!isRecord(value) || value.type !== 'tool_call') return null;
  if (typeof value.name !== 'string' || !tools.some((tool) => tool.name === value.name)) {
    throw new Error(`AI Hub 返回了未注册的工具调用：${String(value.name ?? '')}`);
  }
  if (!isRecord(value.arguments)) {
    throw new Error(`AI Hub 工具 ${value.name} 的 arguments 必须是 JSON 对象`);
  }
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : createToolCallId(),
    name: value.name,
    arguments: value.arguments,
  };
}

const DSML_MARKER = '｜｜DSML｜｜';
const DSML_CLOSE_PREFIX = String.raw`\\?<\/`;

function parseDsmlToolCall(text: string): Record<string, unknown> | null {
  if (!text.includes(DSML_MARKER)) return null;
  const escapedMarker = escapeRegExp(DSML_MARKER);
  const callsPattern = new RegExp(
    `<${escapedMarker}\\s+calls\\s*>([\\s\\S]*?)${DSML_CLOSE_PREFIX}${escapedMarker}\\s+calls\\s*>`,
    'g',
  );
  const calls = [...text.matchAll(callsPattern)];
  if (calls.length !== 1) return null;

  const callsBody = calls[0][1];
  const invokePattern = new RegExp(
    `<${escapedMarker}\\s+invoke\\b([^>]*)>([\\s\\S]*?)${DSML_CLOSE_PREFIX}${escapedMarker}\\s+invoke\\s*>`,
    'g',
  );
  const invokes = [...callsBody.matchAll(invokePattern)];
  if (invokes.length !== 1 || callsBody.replace(invokes[0][0], '').trim()) return null;

  const name = readDsmlAttribute(invokes[0][1], 'name');
  if (!name) return null;
  const invokeBody = invokes[0][2];
  const parameterPattern = new RegExp(
    `<${escapedMarker}\\s+parameter\\b([^>]*)>([\\s\\S]*?)${DSML_CLOSE_PREFIX}${escapedMarker}\\s+parameter\\s*>`,
    'g',
  );
  const parameters = [...invokeBody.matchAll(parameterPattern)];
  if (parameters.length === 0 || invokeBody.replace(parameterPattern, '').trim()) return null;

  const args: Record<string, unknown> = {};
  for (const parameter of parameters) {
    const parameterName = readDsmlAttribute(parameter[1], 'name');
    if (!parameterName || Object.prototype.hasOwnProperty.call(args, parameterName)) return null;
    const body = decodeDsmlEntities(parameter[2]).replace(/^\r?\n|\r?\n$/g, '');
    args[parameterName] = readDsmlAttribute(parameter[1], 'string') === 'true'
      ? body
      : parseDsmlParameterValue(body);
  }
  return { type: 'tool_call', name: decodeDsmlEntities(name), arguments: args };
}

function readDsmlAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return match ? decodeDsmlEntities(match[1] ?? match[2] ?? '') : null;
}

function parseDsmlParameterValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeDsmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseToolCallEnvelope(text: string): unknown | null {
  try {
    const direct = JSON.parse(text);
    if (isRecord(direct) && direct.type === 'tool_call') return direct;
  } catch {
    // Some webpage models prepend reasoning or append prose despite the
    // protocol. Scan complete JSON objects without treating braces in strings
    // as structure, then accept the first actual tool_call envelope.
  }
  const broadStart = text.indexOf('{');
  const broadEnd = text.lastIndexOf('}');
  if (broadStart >= 0 && broadEnd > broadStart && text.slice(broadStart, broadEnd + 1).includes('"tool_call"')) {
    try {
      const repaired = JSON.parse(repairMalformedToolCallJson(text.slice(broadStart, broadEnd + 1)));
      if (isRecord(repaired) && repaired.type === 'tool_call') return repaired;
    } catch {
      // Continue with narrower candidates when surrounding prose has braces.
    }
  }
  for (const line of text.split('\n')) {
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start < 0 || end <= start || !line.includes('"tool_call"')) continue;
    try {
      const repaired = JSON.parse(repairMalformedToolCallJson(line.slice(start, end + 1)));
      if (isRecord(repaired) && repaired.type === 'tool_call') return repaired;
    } catch {
      // Fall through to strict balanced-object recovery.
    }
  }
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const candidate = JSON.parse(repairMalformedToolCallJson(text.slice(start, index + 1)));
          if (isRecord(candidate) && candidate.type === 'tool_call') return candidate;
        } catch {
          // Continue at the next opening brace; nested valid objects remain discoverable.
        }
        break;
      }
    }
  }
  return null;
}

function repairMalformedToolCallJson(text: string): string {
  return repairInvalidJsonStringEscapes(repairUnescapedJsonStringQuotes(text));
}

function repairInvalidJsonStringEscapes(text: string): string {
  let result = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let precedingBackslashes = 0;
      for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) precedingBackslashes += 1;
      if (precedingBackslashes % 2 === 0) inString = !inString;
      result += char;
      continue;
    }
    if (char !== '\\' || !inString) {
      if (inString && char === '\n') result += '\\n';
      else if (inString && char === '\r') result += '\\r';
      else if (inString && char === '\t') result += '\\t';
      else result += char;
      continue;
    }
    const next = text[index + 1] ?? '';
    const validSimpleEscape = '"\\/bfnrt'.includes(next);
    const validUnicodeEscape = next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6));
    result += validSimpleEscape || validUnicodeEscape ? '\\' : '\\\\';
  }
  return result;
}

function repairUnescapedJsonStringQuotes(text: string): string {
  let result = '';
  let inString = false;
  let stringIsKey = false;
  let escaped = false;
  let previousSignificant = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!inString) {
      result += char;
      if (char === '"') {
        inString = true;
        stringIsKey = previousSignificant === '{' || previousSignificant === ',';
      } else if (!/\s/.test(char)) {
        previousSignificant = char;
      }
      continue;
    }
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }
    if (char !== '"') {
      result += char;
      continue;
    }
    const next = text.slice(index + 1).match(/^\s*([,:}\]])/)?.[1];
    const closesString = stringIsKey ? next === ':' : next === ',' || next === '}';
    if (closesString) {
      result += char;
      inString = false;
      previousSignificant = '"';
    } else {
      result += '\\"';
    }
  }
  return result;
}

function emitReply(reply: string, tools: ToolDefinition[]): StreamEvent[] {
  try {
    const toolCall = parseAiHubToolCall(reply, tools);
    if (toolCall) return [{ type: 'tool_call', toolCall }];
  } catch (error) {
    return [{ type: 'error', message: error instanceof Error ? error.message : String(error) }];
  }
  return [...emitText(reply), { type: 'text_done' }];
}

function unwrapJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createToolCallId(): string {
  return `call_aihub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 定位携带本轮锚点的注入消息，返回其后最后一条 assistant 文本（网页生成中会渐进变长）
export function extractReplyAfterAnchor(messages: AiHubCaptureMessage[], anchorHead: string): string {
  const injectedIndex = findLastIndex(messages, (message) => message.role === 'user' && message.text.includes(anchorHead));
  if (injectedIndex < 0) return '';
  for (let index = messages.length - 1; index > injectedIndex; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.text.trim()) return message.text;
  }
  return '';
}

export function extractReplyAfterBaseline(messages: AiHubCaptureMessage[], baselineAssistantTexts: string[]): string {
  const current = messages
    .filter((message) => message.role === 'assistant' && message.text.trim())
    .map((message) => message.text);
  if (current.length === 0) return '';
  if (current.length > baselineAssistantTexts.length) return current[current.length - 1];
  const latest = current[current.length - 1];
  return latest !== baselineAssistantTexts[baselineAssistantTexts.length - 1] ? latest : '';
}

function emitText(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (let offset = 0; offset < text.length; offset += CHUNK_CHARS) {
    events.push({ type: 'text_chunk', text: text.slice(offset, offset + CHUNK_CHARS) });
  }
  return events;
}

function latestUserImages(messages: Message[]): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].images ?? [];
  }
  return [];
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content === null || message.content === undefined) return '';
  try {
    return JSON.stringify(message.content);
  } catch {
    return String(message.content);
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
