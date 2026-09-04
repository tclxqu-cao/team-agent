import { BookOpen, Lightbulb, Wrench } from "lucide-react";
import type { AgentType } from "../global";

export const EMPTY_SESSION_STARTERS = [
  { prompt: "带我熟悉这个项目", Icon: BookOpen },
  { prompt: "帮我排查一个问题", Icon: Wrench },
  { prompt: "一起实现一个新想法", Icon: Lightbulb },
] as const;

const AGENT_LABELS: Record<AgentType, string> = {
  "customer-agent": "Customer Agent",
  codex: "Codex",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
};

interface EmptySessionWelcomeProps {
  agentType: AgentType;
  ready: boolean;
  onSelectPrompt(prompt: string): void;
}

export default function EmptySessionWelcome({
  agentType,
  ready,
  onSelectPrompt,
}: EmptySessionWelcomeProps) {
  const agentLabel = AGENT_LABELS[agentType];

  return (
    <section className="empty-session-welcome" aria-labelledby="empty-session-welcome-title">
      <div className="empty-session-welcome__core" aria-hidden="true">
        <span className="empty-session-welcome__glow" />
        <svg viewBox="0 0 120 120" role="presentation">
          <circle className="empty-session-welcome__orbit empty-session-welcome__orbit--outer" cx="60" cy="60" r="44" />
          <circle className="empty-session-welcome__orbit empty-session-welcome__orbit--inner" cx="60" cy="60" r="33" />
          <rect className="empty-session-welcome__diamond" x="43" y="43" width="34" height="34" rx="2" />
          <circle className="empty-session-welcome__pulse" cx="60" cy="60" r="3" />
        </svg>
      </div>

      <div className="empty-session-welcome__copy">
        <p className="empty-session-welcome__status">
          {ready ? `${agentLabel} · 已准备好` : `${agentLabel} · 等待配置`}
        </p>
        <h2 id="empty-session-welcome-title">嗨，我在。</h2>
        <p className="empty-session-welcome__prompt">
          {ready ? "今天想一起做点什么？" : "配置好 API Key 后，我就能开始。"}
        </p>
      </div>

      <div className="empty-session-welcome__starters" aria-label="开始一个任务">
        {EMPTY_SESSION_STARTERS.map(({ prompt, Icon }) => (
          <button
            key={prompt}
            type="button"
            data-prompt={prompt}
            disabled={!ready}
            onClick={() => onSelectPrompt(prompt)}
          >
            <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>{prompt}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
