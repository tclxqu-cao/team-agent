import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { randomUUID } from "node:crypto";
import { Box, useApp } from "ink";
import type { AskUserRequest, AskUserResponse, SkillMeta } from "@agent/core";
import { BUILTIN_COMMANDS, createSlashItems, helpText, parseSlashCommand } from "./commands.js";
import {
  emptyTuiConfig,
  endpointModelSelection,
  loadTuiConfig,
  parseManualModel,
  saveTuiConfig,
  saveTuiModelSelection,
  upsertCustomEndpoint,
  type CustomModelEndpoint,
  type DesktopModelProfile,
  type ModelSelection,
  type TuiConfig,
} from "./model-config.js";
import { fetchAvailableModels, normalizeModelEndpoint } from "./model-discovery.js";
import { startModelWizard, type ModelWizardState } from "./model-wizard.js";
import { AgentEventBuffer } from "./stream-buffer.js";
import { filterPaletteItems, getActiveTrigger, replaceTrigger, type PaletteItem } from "./palette.js";
import { resolveProjectNavigation } from "./project-routing.js";
import { indexProjectResources, mergeProjects, replaceMentionToken, scanSiblingProjects, type ProjectCandidate, type RegisteredProject } from "./resources.js";
import { initialTuiState, tuiReducer, type TranscriptEntry } from "./state.js";
import { TuiRuntime, type RuntimeSnapshot, type SessionSummary } from "./runtime.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Composer } from "./components/Composer.js";
import { InlineQuestion } from "./components/InlineQuestion.js";
import { MessageQueue } from "./components/MessageQueue.js";
import { ModelWizard } from "./components/ModelWizard.js";
import { ProgressLine } from "./components/ProgressLine.js";
import { Transcript } from "./components/Transcript.js";
import { Header } from "./components/Header.js";
import { PALETTE_TITLES } from "./theme.js";

type SecondaryPalette = "models" | "wizard-models" | "sessions" | "projects" | "skills";
interface PendingQuestion {
  request: AskUserRequest;
  resolve: (response: AskUserResponse) => void;
}

export interface TuiAppProps {
  runtime: TuiRuntime;
  initialSnapshot: RuntimeSnapshot;
  profiles: DesktopModelProfile[];
  registeredProjects: RegisteredProject[];
  configPath: string;
  env: NodeJS.ProcessEnv;
  warnings?: string[];
  nativeCursor?: boolean;
  initialConfig?: TuiConfig;
  modelFetcher?: typeof fetchAvailableModels;
}

function entry(type: "user" | "notice" | "error", text: string): TranscriptEntry {
  if (type === "user") return { id: `${type}:${Date.now()}:${Math.random()}`, type, text };
  if (type === "error") return { id: `${type}:${Date.now()}:${Math.random()}`, type, text };
  return { id: `${type}:${Date.now()}:${Math.random()}`, type, text };
}

function sessionItems(sessions: SessionSummary[]): PaletteItem[] {
  return sessions.map((session) => ({
    id: `session:${session.id}`,
    kind: "session",
    label: session.title,
    description: `${session.created.slice(0, 16).replace("T", " ")} · ${session.id.slice(0, 8)}`,
    value: session.id,
  }));
}

function modelItems(
  profiles: DesktopModelProfile[],
  endpoints: CustomModelEndpoint[],
  active: ModelSelection,
): PaletteItem[] {
  const customItems: PaletteItem[] = endpoints.flatMap((endpoint) => endpoint.models.map((modelId) => ({
    id: `model:custom:${endpoint.id}:${modelId}`,
    kind: "model" as const,
    label: modelId,
    description: `${endpoint.name}${modelId === endpoint.defaultModelId ? " · 默认" : ""}`,
    value: `__custom__\0${endpoint.id}\0${modelId}`,
  })));
  const desktopItems: PaletteItem[] = profiles.map((profile) => ({
    id: `model:${profile.sourcePath}:${profile.id}`,
    kind: "model",
    label: profile.name || profile.modelId,
    description: `${profile.provider}/${profile.modelId}${profile.apiKey ? "" : " · 缺少 API Key"}`,
    value: `${profile.sourcePath}\0${profile.id}`,
    disabled: !profile.apiKey,
  }));
  const items = [...customItems, ...desktopItems];
  const activePresent = active.source === "custom"
    ? customItems.some((item) => item.value === `__custom__\0${active.endpointId}\0${active.modelId}`)
    : desktopItems.some((item) => item.description.startsWith(`${active.provider}/${active.modelId}`));
  if (!activePresent) {
    items.unshift({
      id: "model:current",
      kind: "model",
      label: active.name,
      description: `${active.provider}/${active.modelId} · 当前配置`,
      value: "__current__",
    });
  }
  items.push({
    id: "action:model-configure",
    kind: "action",
    label: "配置模型服务",
    description: "输入 URL 和 API Key，获取全部模型",
    value: "__configure__",
  });
  for (const endpoint of endpoints) {
    items.push({
      id: `action:model-refresh:${endpoint.id}`,
      kind: "action",
      label: `刷新 ${endpoint.name}`,
      description: `${endpoint.models.length} 个已缓存模型`,
      value: `__refresh__\0${endpoint.id}`,
    });
  }
  items.push({
    id: "action:model-manual",
    kind: "action",
    label: "手动输入 provider/model-id",
    description: "使用 AGENT_API_KEY",
    value: "__manual__",
  });
  return items;
}

function skillItems(skills: SkillMeta[]): PaletteItem[] {
  return createSlashItems(skills).filter((item) => item.kind === "skill");
}

export function TuiApp(props: TuiAppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(tuiReducer, initialTuiState);
  const [snapshot, setSnapshot] = useState(props.initialSnapshot);
  const [projects, setProjects] = useState<ProjectCandidate[]>([]);
  const [resources, setResources] = useState<PaletteItem[]>([]);
  const [secondary, setSecondary] = useState<SecondaryPalette | null>(null);
  const [secondaryItems, setSecondaryItems] = useState<PaletteItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [queuedInputs, setQueuedInputs] = useState<string[]>([]);
  const [tuiConfig, setTuiConfig] = useState<TuiConfig>(props.initialConfig ?? emptyTuiConfig());
  const [modelWizard, setModelWizard] = useState<ModelWizardState | null>(null);
  const queuedInputsRef = useRef<string[]>([]);
  const abortingRef = useRef(false);
  const wizardGenerationRef = useRef(0);

  const append = useCallback((type: "notice" | "error", text: string) => {
    dispatch({ type: "append", entry: entry(type, text) });
  }, []);

  const refreshResources = useCallback(async (workingDirectory: string) => {
    try {
      const [discovered, indexed] = await Promise.all([
        scanSiblingProjects(workingDirectory),
        indexProjectResources(workingDirectory),
      ]);
      setProjects(await mergeProjects(discovered, props.registeredProjects));
      setResources(indexed.items);
      for (const warning of indexed.warnings.slice(0, 3)) append("notice", `索引跳过: ${warning}`);
      if (indexed.truncated) append("notice", "文件索引已达到 10000 项上限");
    } catch (error) {
      append("error", `资源索引失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [append, props.registeredProjects]);

  useEffect(() => {
    void refreshResources(snapshot.workingDirectory);
  }, [refreshResources, snapshot.workingDirectory]);

  useEffect(() => {
    for (const warning of props.warnings ?? []) append("notice", warning);
  }, [append, props.warnings]);

  useEffect(() => {
    props.runtime.setQuestionHandler((request) => new Promise((resolve) => setQuestion({ request, resolve })));
  }, [props.runtime]);

  const trigger = question || secondary || modelWizard ? null : getActiveTrigger(state.input, state.cursor);
  const slashItems = useMemo(() => createSlashItems(snapshot.skills), [snapshot.skills]);
  const baseItems = useMemo(() => {
    if (secondary) return secondaryItems;
    if (trigger?.type === "slash") return slashItems;
    if (trigger?.type === "mention") return [...projects, ...resources];
    return [];
  }, [projects, resources, secondary, secondaryItems, slashItems, trigger?.type]);
  const query = useMemo(() => {
    if (trigger) return trigger.query;
    if (!secondary) return "";
    if (secondary === "wizard-models") return state.input;
    const prefix = secondary === "models" ? "/model" : secondary === "sessions" ? "/open" : secondary === "projects" ? "/projects" : "/skills";
    return state.input.startsWith(prefix) ? state.input.slice(prefix.length).trimStart() : "";
  }, [secondary, state.input, trigger]);
  const visibleItems = useMemo(
    () => filterPaletteItems(
      baseItems,
      query,
      secondary === "models" || secondary === "wizard-models" ? Math.max(1, baseItems.length) : 12,
    ),
    [baseItems, query, secondary],
  );
  const paletteOpen = !paletteDismissed && Boolean(secondary || trigger);
  const paletteTitle = secondary
    ? secondary === "wizard-models" ? "选择默认模型" : PALETTE_TITLES[secondary]
    : trigger?.type === "mention"
      ? PALETTE_TITLES.mention
      : PALETTE_TITLES.slash;

  useEffect(() => setSelectedIndex(0), [query, secondary, trigger?.type]);

  const setInput = useCallback((input: string, cursor = input.length) => {
    setPaletteDismissed(false);
    dispatch({ type: "set_input", input, cursor });
  }, []);

  const openSecondary = useCallback(async (kind: SecondaryPalette) => {
    if (kind === "models") setSecondaryItems(modelItems(props.profiles, tuiConfig.endpoints, snapshot.model));
    if (kind === "sessions") setSecondaryItems(sessionItems(await props.runtime.listSessions()));
    if (kind === "projects") setSecondaryItems(projects);
    if (kind === "skills") setSecondaryItems(skillItems(snapshot.skills));
    setPaletteDismissed(false);
    setSecondary(kind);
    setSelectedIndex(0);
  }, [projects, props.profiles, props.runtime, snapshot.model, snapshot.skills, tuiConfig.endpoints]);

  const switchModel = useCallback(async (selection: ModelSelection) => {
    try {
      const next = await props.runtime.switchModel(selection);
      await saveTuiModelSelection(props.configPath, selection);
      setTuiConfig(await loadTuiConfig(props.configPath));
      setSnapshot(next);
      dispatch({ type: "clear" });
      append("notice", `已切换模型 ${selection.provider}/${selection.modelId} · 新会话 ${next.sessionId.slice(0, 8)}`);
    } catch (error) {
      append("error", `模型切换失败，保留当前模型: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [append, props.configPath, props.runtime]);

  const switchProject = useCallback(async (directory: string) => {
    try {
      const next = await props.runtime.switchProject(directory);
      setSnapshot(next);
      dispatch({ type: "clear" });
      setInput("");
      append("notice", `已切换项目 ${next.workingDirectory} · 新会话 ${next.sessionId.slice(0, 8)}`);
    } catch (error) {
      append("error", `项目切换失败，保留当前项目: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [append, props.runtime, setInput]);

  const cancelModelWizard = useCallback(() => {
    wizardGenerationRef.current++;
    setModelWizard(null);
    setSecondary(null);
    setInput("");
  }, [setInput]);

  const beginModelWizard = useCallback(() => {
    wizardGenerationRef.current++;
    setSecondary(null);
    setModelWizard(startModelWizard());
    setInput("");
  }, [setInput]);

  const submitModelWizard = useCallback(async (input: string) => {
    if (!modelWizard || modelWizard.step === "fetching" || modelWizard.step === "model") return;
    if (modelWizard.step === "url") {
      try {
        setInput("");
        setModelWizard({ step: "apiKey", endpoint: normalizeModelEndpoint(input) });
      } catch (error) {
        append("error", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const apiKey = input.trim();
    if (!apiKey) {
      append("error", "API Key 不能为空");
      return;
    }
    const generation = ++wizardGenerationRef.current;
    const endpoint = modelWizard.endpoint;
    setInput("");
    setModelWizard({ step: "fetching", endpoint, apiKey });
    try {
      const result = await (props.modelFetcher ?? fetchAvailableModels)({
        baseUrl: endpoint.modelsUrl,
        apiKey,
      });
      if (generation !== wizardGenerationRef.current) return;
      setModelWizard({ step: "model", endpoint: result.endpoint, apiKey, models: result.models });
      setSecondaryItems(result.models.map((modelId) => ({
        id: `wizard-model:${modelId}`,
        kind: "model",
        label: modelId,
        description: result.endpoint.name,
        value: modelId,
      })));
      setSecondary("wizard-models");
      setSelectedIndex(0);
    } catch (error) {
      if (generation !== wizardGenerationRef.current) return;
      setModelWizard({ step: "apiKey", endpoint });
      append("error", error instanceof Error ? error.message : String(error));
    }
  }, [append, modelWizard, props.modelFetcher, setInput]);

  const refreshCustomEndpoint = useCallback(async (endpoint: CustomModelEndpoint) => {
    const generation = ++wizardGenerationRef.current;
    const normalized = { baseUrl: endpoint.baseUrl, modelsUrl: endpoint.modelsUrl, name: endpoint.name };
    setSecondary(null);
    setModelWizard({ step: "fetching", endpoint: normalized, apiKey: endpoint.apiKey });
    setInput("");
    try {
      const result = await (props.modelFetcher ?? fetchAvailableModels)({
        baseUrl: endpoint.modelsUrl,
        apiKey: endpoint.apiKey,
      });
      if (generation !== wizardGenerationRef.current) return;
      const refreshed: CustomModelEndpoint = {
        ...endpoint,
        ...result.endpoint,
        defaultModelId: result.models.includes(endpoint.defaultModelId) ? endpoint.defaultModelId : result.models[0],
        models: result.models,
        updatedAt: new Date().toISOString(),
      };
      const nextConfig = upsertCustomEndpoint(tuiConfig, refreshed);
      await saveTuiConfig(props.configPath, nextConfig);
      setTuiConfig(nextConfig);
      setModelWizard(null);
      setSecondaryItems(modelItems(props.profiles, nextConfig.endpoints, snapshot.model));
      setSecondary("models");
      append("notice", `已刷新 ${refreshed.name} · ${refreshed.models.length} 个模型`);
    } catch (error) {
      if (generation !== wizardGenerationRef.current) return;
      setModelWizard(null);
      setSecondaryItems(modelItems(props.profiles, tuiConfig.endpoints, snapshot.model));
      setSecondary("models");
      append("error", `${endpoint.name} 刷新失败，已保留缓存: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [append, props.configPath, props.modelFetcher, props.profiles, setInput, snapshot.model, tuiConfig]);

  const steerQueuedInput = useCallback(async (args: string) => {
    if (!state.running) {
      append("error", "/steer 只能在 Agent 运行时使用");
      return;
    }
    const queueIndex = Number(args);
    if (!Number.isInteger(queueIndex) || queueIndex < 1 || queueIndex > queuedInputsRef.current.length) {
      append("error", `用法: /steer <序号>；当前有 ${queuedInputsRef.current.length} 条排队消息`);
      return;
    }

    const index = queueIndex - 1;
    const message = queuedInputsRef.current[index];
    try {
      await props.runtime.steer(message);
      queuedInputsRef.current.splice(index, 1);
      setQueuedInputs([...queuedInputsRef.current]);
      dispatch({ type: "append", entry: entry("user", message) });
      append("notice", `已将队列第 ${queueIndex} 条插入当前轮`);
    } catch (error) {
      append("error", `插入当前轮失败，消息仍在队列: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [append, props.runtime, state.running]);

  const executeBuiltin = useCallback(async (name: string, args: string) => {
    switch (name) {
      case "/help":
        append("notice", helpText().join("\n"));
        break;
      case "/new": {
        const id = await props.runtime.newSession();
        dispatch({ type: "clear" });
        append("notice", `已新建会话 ${id.slice(0, 8)}`);
        setSnapshot(props.runtime.snapshot());
        break;
      }
      case "/sessions": {
        const sessions = await props.runtime.listSessions();
        append("notice", sessions.length
          ? sessions.map((session) => `${session.id === snapshot.sessionId ? "*" : "-"} ${session.title}  ${session.id.slice(0, 8)}`).join("\n")
          : "还没有会话");
        break;
      }
      case "/open":
        if (!args) return void await openSecondary("sessions");
        await props.runtime.openSession(args);
        setSnapshot(props.runtime.snapshot());
        append("notice", `已打开会话 ${props.runtime.snapshot().sessionId.slice(0, 8)}`);
        break;
      case "/cwd":
        append("notice", snapshot.workingDirectory);
        break;
      case "/model":
        if (!args) return void await openSecondary("models");
        await switchModel(parseManualModel(args, props.env));
        break;
      case "/projects":
        await openSecondary("projects");
        break;
      case "/skills":
        await openSecondary("skills");
        break;
      case "/steer":
        await steerQueuedInput(args);
        break;
      case "/clear":
        dispatch({ type: "clear" });
        break;
      case "/exit":
        exit();
        break;
    }
  }, [append, exit, openSecondary, props.env, props.runtime, snapshot.sessionId, snapshot.workingDirectory, steerQueuedInput, switchModel]);

  const runInputQueue = useCallback(async (firstInput: string) => {
    abortingRef.current = false;
    let currentInput: string | undefined = firstInput;
    while (currentInput) {
      const parsed = parseSlashCommand(currentInput);
      dispatch({ type: "append", entry: entry("user", currentInput) });
      dispatch({ type: "turn_start", now: Date.now() });
      const eventBuffer = new AgentEventBuffer((event) => {
        dispatch({ type: "agent_event", event, now: Date.now() });
      });
      try {
        await props.runtime.run(parsed.type === "agent" ? parsed.input : currentInput, (event) => {
          eventBuffer.push(event);
        });
      } catch (error) {
        eventBuffer.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        eventBuffer.dispose();
      }
      if (abortingRef.current) break;
      currentInput = queuedInputsRef.current.shift();
      setQueuedInputs([...queuedInputsRef.current]);
    }
  }, [props.runtime]);

  const submit = useCallback(async () => {
    if (modelWizard) {
      await submitModelWizard(state.input);
      return;
    }
    const input = state.input.trim();
    if (!input) return;
    if (question) {
      const numeric = Number.parseInt(input, 10);
      const answer = Number.isInteger(numeric) && numeric >= 1 && numeric <= (question.request.options?.length ?? 0)
        ? question.request.options![numeric - 1].label
        : input;
      question.resolve({ answer });
      setQuestion(null);
      setInput("");
      return;
    }
    dispatch({ type: "submit_input", input });
    setSecondary(null);
    const parsed = parseSlashCommand(input);
    if (parsed.type === "builtin") {
      if (state.running && parsed.name !== "/steer") {
        append("notice", `运行中未执行 ${parsed.name}；普通消息可以继续排队`);
        return;
      }
      try {
        await executeBuiltin(parsed.name, parsed.args);
      } catch (error) {
        append("error", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (state.running) {
      queuedInputsRef.current.push(input);
      setQueuedInputs([...queuedInputsRef.current]);
      return;
    }
    const navigation = resolveProjectNavigation(input, projects);
    if (navigation.type === "match") {
      await switchProject(navigation.project.value);
      return;
    }
    if (navigation.type === "ambiguous") {
      setSecondaryItems(navigation.projects);
      setSecondary("projects");
      setSelectedIndex(0);
      append("notice", `找到多个“${navigation.query}”项目，请选择`);
      return;
    }
    void runInputQueue(input);
  }, [append, executeBuiltin, modelWizard, projects, question, runInputQueue, setInput, state.input, state.running, submitModelWizard, switchProject]);

  const choosePaletteItem = useCallback(async () => {
    const item = visibleItems[selectedIndex];
    if (!item || item.disabled) return;
    if (secondary === "wizard-models" && modelWizard?.step === "model") {
      const existing = tuiConfig.endpoints.find((endpoint) => endpoint.baseUrl === modelWizard.endpoint.baseUrl);
      const endpoint: CustomModelEndpoint = {
        id: existing?.id ?? randomUUID(),
        name: modelWizard.endpoint.name,
        baseUrl: modelWizard.endpoint.baseUrl,
        modelsUrl: modelWizard.endpoint.modelsUrl,
        apiKey: modelWizard.apiKey,
        defaultModelId: item.value,
        models: modelWizard.models,
        updatedAt: new Date().toISOString(),
      };
      try {
        const nextConfig = upsertCustomEndpoint(tuiConfig, endpoint);
        await saveTuiConfig(props.configPath, nextConfig);
        setTuiConfig(nextConfig);
        await switchModel(endpointModelSelection(endpoint, item.value));
        setModelWizard(null);
        setSecondary(null);
        setInput("");
      } catch (error) {
        append("error", `模型服务保存失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (secondary === "models") {
      if (item.value === "__configure__") {
        beginModelWizard();
        return;
      }
      if (item.value.startsWith("__refresh__\0")) {
        const endpointId = item.value.split("\0")[1];
        const endpoint = tuiConfig.endpoints.find((candidate) => candidate.id === endpointId);
        if (endpoint) await refreshCustomEndpoint(endpoint);
        return;
      }
      if (item.value === "__manual__") {
        setSecondary(null);
        setInput("/model ");
        return;
      }
      if (item.value.startsWith("__custom__\0")) {
        const [, endpointId, modelId] = item.value.split("\0");
        const endpoint = tuiConfig.endpoints.find((candidate) => candidate.id === endpointId);
        if (endpoint) await switchModel(endpointModelSelection(endpoint, modelId));
        setSecondary(null);
        setInput("");
        return;
      }
      if (item.value !== "__current__") {
        const [sourcePath, profileId] = item.value.split("\0");
        const profile = props.profiles.find((candidate) => candidate.sourcePath === sourcePath && candidate.id === profileId);
        if (profile) await switchModel({ ...profile, source: "desktop" });
      }
      setSecondary(null);
      setInput("");
      return;
    }
    if (secondary === "sessions") {
      await props.runtime.openSession(item.value);
      setSnapshot(props.runtime.snapshot());
      append("notice", `已打开会话 ${item.value.slice(0, 8)}`);
      setSecondary(null);
      setInput("");
      return;
    }
    if (secondary === "projects" || item.kind === "project") {
      await switchProject(item.value);
      setSecondary(null);
      return;
    }
    if (secondary === "skills") {
      setSecondary(null);
      setInput(`${item.value} `);
      return;
    }
    if (trigger?.type === "slash") {
      if (item.kind === "command") {
        const command = BUILTIN_COMMANDS.find((candidate) => candidate.name === item.value);
        // No-argument commands (/exit, /clear, /help, /new, /cwd) run on
        // select — filling the input made them look broken until a second
        // Enter. Argument-taking (/steer) and panel commands keep the old path.
        if (command && !command.secondary && command.name !== "/steer") {
          setInput("");
          await executeBuiltin(item.value, "");
          return;
        }
      }
      const next = replaceTrigger(state.input, state.cursor, trigger, `${item.value} `);
      setInput(next.buffer, next.cursor);
      if (item.kind === "command") {
        const command = BUILTIN_COMMANDS.find((candidate) => candidate.name === item.value);
        if (command?.secondary) await openSecondary(command.secondary);
      }
      return;
    }
    if (trigger?.type === "mention") {
      const next = replaceMentionToken(state.input, state.cursor, trigger, item.value);
      setInput(next.buffer, next.cursor);
    }
  }, [append, beginModelWizard, executeBuiltin, modelWizard, openSecondary, props.configPath, props.profiles, props.runtime, refreshCustomEndpoint, secondary, selectedIndex, setInput, state.cursor, state.input, switchModel, switchProject, trigger, tuiConfig, visibleItems]);

  const abortTurn = useCallback(() => {
    abortingRef.current = true;
    queuedInputsRef.current = [];
    setQueuedInputs([]);
    if (question) {
      question.resolve({ answer: "" });
      setQuestion(null);
      setInput("");
    }
    props.runtime.abort();
  }, [props.runtime, question, setInput]);

  const closePalette = useCallback(() => {
    if (secondary === "wizard-models") {
      cancelModelWizard();
      return;
    }
    setSecondary(null);
    setPaletteDismissed(true);
    if (trigger) {
      const input = state.input.slice(0, trigger.start) + state.input.slice(state.cursor);
      dispatch({ type: "set_input", input, cursor: trigger.start });
    } else if (secondary) {
      dispatch({ type: "set_input", input: "", cursor: 0 });
    }
  }, [cancelModelWizard, secondary, state.cursor, state.input, trigger]);

  const conversationStarted = state.transcript.some((item) => item.type === "user" || item.type === "assistant" || item.type === "tool");

  return (
    <Box flexDirection="column">
      <Header snapshot={snapshot} running={state.running} expanded={!paletteOpen && !modelWizard && !conversationStarted} />
      <Transcript entries={state.transcript} />
      <ProgressLine progress={state.progress} />
      {question ? <InlineQuestion request={question.request} /> : null}
      <MessageQueue items={queuedInputs} />
      {modelWizard ? <ModelWizard state={modelWizard} /> : null}
      <Box
        flexDirection="column"
        marginTop={1}
      >
        {paletteOpen ? <CommandPalette items={visibleItems} selectedIndex={selectedIndex} title={paletteTitle} /> : null}
        <Composer
          input={state.input}
          cursor={state.cursor}
          running={state.running}
          questionActive={Boolean(question)}
          paletteOpen={paletteOpen}
          nativeCursor={props.nativeCursor}
          inputMode={modelWizard
            ? modelWizard.step === "url"
              ? "model-url"
              : modelWizard.step === "apiKey"
                ? "model-key"
                : modelWizard.step === "fetching"
                  ? "model-fetching"
                  : "model-select"
            : "message"}
          onChange={setInput}
          onSubmit={() => void submit()}
          onHistory={(direction) => dispatch({ type: "history", direction })}
          onPaletteMove={(direction) => {
            setTimeout(() => setSelectedIndex((value) => {
              if (visibleItems.length === 0) return 0;
              return (value + direction + visibleItems.length) % visibleItems.length;
            }), 0);
          }}
          onPaletteSelect={() => void choosePaletteItem()}
          onPaletteClose={closePalette}
          onAbort={abortTurn}
          onExit={exit}
          onCancel={cancelModelWizard}
        />
      </Box>
    </Box>
  );
}
