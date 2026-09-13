import { BookOpen, Lightbulb, Wrench } from "lucide-react";
import type { AgentType } from "../global";

export const EMPTY_SESSION_STARTERS = [
  { prompt: "带我熟悉这个项目", Icon: BookOpen },
  { prompt: "帮我排查一个问题", Icon: Wrench },
  { prompt: "一起实现一个新想法", Icon: Lightbulb },
] as const;

// 空会话首屏问候按钟点分段，语气跟着时段走（深夜关心休息，午后轻快）。
export function welcomeGreetingForHour(hour: number): { title: string; prompt: string } {
  if (hour >= 5 && hour < 9) return { title: "早啊。", prompt: "新的一天，想做点什么？" };
  if (hour >= 9 && hour < 12) return { title: "上午好。", prompt: "今天想一起做点什么？" };
  if (hour >= 12 && hour < 14) return { title: "中午好。", prompt: "想趁午休推进点什么？" };
  if (hour >= 14 && hour < 18) return { title: "下午好。", prompt: "这个下午，想做点什么？" };
  if (hour >= 18 && hour < 23) return { title: "晚上好。", prompt: "今晚想一起做点什么？" };
  return { title: "夜深了。", prompt: "注意休息，重要的事可以先留给我。" };
}

const AGENT_LABELS: Record<AgentType, string> = {
  "customer-agent": "Customer Agent",
  codex: "Codex",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
};

interface EmptySessionWelcomeProps {
  agentType: AgentType;
  ready: boolean;
  /** 测试注入用；生产渲染取当前时间。 */
  now?: Date;
  onSelectPrompt(prompt: string): void;
}

export default function EmptySessionWelcome({
  agentType,
  ready,
  now,
  onSelectPrompt,
}: EmptySessionWelcomeProps) {
  const agentLabel = AGENT_LABELS[agentType];
  const greeting = welcomeGreetingForHour((now ?? new Date()).getHours());

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
        <h2 id="empty-session-welcome-title">{greeting.title}</h2>
        <p className="empty-session-welcome__prompt">
          {ready ? greeting.prompt : "配置好 API Key 后，我就能开始。"}
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
