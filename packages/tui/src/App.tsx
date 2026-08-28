import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, useApp } from "ink";
import type { AskUserRequest, AskUserResponse, SkillMeta } from "@agent/core";
import { BUILTIN_COMMANDS, createSlashItems, helpText, parseSlashCommand } from "./commands.js";
import { parseManualModel, saveTuiModelSelection, type DesktopModelProfile, type ModelSelection } from "./model-config.js";
import { filterPaletteItems, getActiveTrigger, replaceTrigger, type PaletteItem } from "./palette.js";
import { indexProjectResources, mergeProjects, replaceMentionToken, scanSiblingProjects, type ProjectCandidate, type RegisteredProject } from "./resources.js";
import { initialTuiState, tuiReducer, type TranscriptEntry } from "./state.js";
import { TuiRuntime, type RuntimeSnapshot, type SessionSummary } from "./runtime.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Composer } from "./components/Composer.js";
import { InlineQuestion } from "./components/InlineQuestion.js";
import { MessageQueue } from "./components/MessageQueue.js";
import { ProgressLine } from "./components/ProgressLine.js";
import { Transcript } from "./components/Transcript.js";
import { Header } from "./components/Header.js";
import { PALETTE_TITLES } from "./theme.js";

type SecondaryPalette = "models" | "sessions" | "projects" | "skills";
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

function modelItems(profiles: DesktopModelProfile[], active: ModelSelection): PaletteItem[] {
  const items: PaletteItem[] = profiles.map((profile) => ({
    id: `model:${profile.sourcePath}:${profile.id}`,
    kind: "model",
    label: profile.name || profile.modelId,
    description: `${profile.provider}/${profile.modelId}${profile.apiKey ? "" : " · 缺少 API Key"}`,
    value: `${profile.sourcePath}\0${profile.id}`,
    disabled: !profile.apiKey,
  }));
  if (!items.some((item) => item.description.startsWith(`${active.provider}/${active.modelId}`))) {
    items.unshift({
      id: "model:current",
      kind: "model",
      label: active.name,
      description: `${active.provider}/${active.modelId} · 当前配置`,
      value: "__current__",
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
  const queuedInputsRef = useRef<string[]>([]);
  const abortingRef = useRef(false);

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

  const trigger = question || secondary ? null : getActiveTrigger(state.input, state.cursor);
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
    const prefix = secondary === "models" ? "/model" : secondary === "sessions" ? "/open" : secondary === "projects" ? "/projects" : "/skills";
    return state.input.startsWith(prefix) ? state.input.slice(prefix.length).trimStart() : "";
  }, [secondary, state.input, trigger]);
  const visibleItems = useMemo(() => filterPaletteItems(baseItems, query), [baseItems, query]);
  const paletteOpen = !paletteDismissed && Boolean(secondary || trigger);
  const paletteTitle = secondary
    ? PALETTE_TITLES[secondary]
    : trigger?.type === "mention"
      ? PALETTE_TITLES.mention
      : PALETTE_TITLES.slash;

  useEffect(() => setSelectedIndex(0), [query, secondary, trigger?.type]);

  const setInput = useCallback((input: string, cursor = input.length) => {
    setPaletteDismissed(false);
    dispatch({ type: "set_input", input, cursor });
  }, []);

  const openSecondary = useCallback(async (kind: SecondaryPalette) => {
    if (kind === "models") setSecondaryItems(modelItems(props.profiles, snapshot.model));
    if (kind === "sessions") setSecondaryItems(sessionItems(await props.runtime.listSessions()));
    if (kind === "projects") setSecondaryItems(projects);
    if (kind === "skills") setSecondaryItems(skillItems(snapshot.skills));
    setPaletteDismissed(false);
    setSecondary(kind);
    setSelectedIndex(0);
  }, [projects, props.profiles, props.runtime, snapshot.model, snapshot.skills]);

  const switchModel = useCallback(async (selection: ModelSelection) => {
    try {
      const next = await props.runtime.switchModel(selection);
      await saveTuiModelSelection(props.configPath, selection);
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
      case "/clear":
        dispatch({ type: "clear" });
        break;
      case "/exit":
        exit();
        break;
    }
  }, [append, exit, openSecondary, props.env, props.runtime, snapshot.sessionId, snapshot.workingDirectory, switchModel]);

  const runInputQueue = useCallback(async (firstInput: string) => {
    abortingRef.current = false;
    let currentInput: string | undefined = firstInput;
    while (currentInput) {
      const parsed = parseSlashCommand(currentInput);
      dispatch({ type: "append", entry: entry("user", currentInput) });
      dispatch({ type: "turn_start", now: Date.now() });
      try {
        await props.runtime.run(parsed.type === "agent" ? parsed.input : currentInput, (event) => {
          dispatch({ type: "agent_event", event, now: Date.now() });
        });
      } catch (error) {
        dispatch({ type: "agent_event", event: { type: "error", message: error instanceof Error ? error.message : String(error) }, now: Date.now() });
      }
      if (abortingRef.current) break;
      currentInput = queuedInputsRef.current.shift();
      setQueuedInputs([...queuedInputsRef.current]);
    }
  }, [props.runtime]);

  const submit = useCallback(async () => {
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
      if (state.running) {
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
    void runInputQueue(input);
  }, [append, executeBuiltin, question, runInputQueue, setInput, state.input, state.running]);

  const choosePaletteItem = useCallback(async () => {
    const item = visibleItems[selectedIndex];
    if (!item || item.disabled) return;
    if (secondary === "models") {
      if (item.value === "__manual__") {
        setSecondary(null);
        setInput("/model ");
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
  }, [append, openSecondary, props.profiles, props.runtime, secondary, selectedIndex, setInput, state.cursor, state.input, switchModel, switchProject, trigger, visibleItems]);

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
    setSecondary(null);
    setPaletteDismissed(true);
    if (trigger) {
      const input = state.input.slice(0, trigger.start) + state.input.slice(state.cursor);
      dispatch({ type: "set_input", input, cursor: trigger.start });
    } else if (secondary) {
      dispatch({ type: "set_input", input: "", cursor: 0 });
    }
  }, [secondary, state.cursor, state.input, trigger]);

  const conversationStarted = state.transcript.some((item) => item.type === "user" || item.type === "assistant" || item.type === "tool");

  return (
    <Box flexDirection="column">
      <Header snapshot={snapshot} running={state.running} expanded={!paletteOpen && !conversationStarted} />
      <Transcript entries={state.transcript} />
      <ProgressLine progress={state.progress} />
      {question ? <InlineQuestion request={question.request} /> : null}
      <MessageQueue items={queuedInputs} />
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
        />
      </Box>
    </Box>
  );
}
