import { AGENT_LABELS } from "../lib/agent-catalog";
import { BookOpen, Lightbulb, Wrench } from "lucide-react";
import type { CSSProperties } from "react";
import type { AgentType } from "../../../shared/src/contracts/agent-api";

const WELCOME_PORTRAIT = new URL("../assets/agentroam-welcome.webp", import.meta.url).href;
const SPEAKING_MOUTH = new URL("../assets/agentroam-welcome-speaking.webp", import.meta.url).href;

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
function SpokenText({ text, start = 0 }: { text: string; start?: number }) {
  return (
    <>
      <span className="empty-session-welcome__accessible-text">{text}</span>
      <span aria-hidden="true">
        {Array.from(text, (character, index) => (
          <span key={index} className="empty-session-welcome__letter" style={{ "--letter-order": start + index } as CSSProperties}>
            {character}
          </span>
        ))}
      </span>
    </>
  );
}

interface EmptySessionWelcomeProps {
  agentType: AgentType;
  ready: boolean;
  connectionRequired?: boolean;
  /** 测试注入用；生产渲染取当前时间。 */
  now?: Date;
  onSelectPrompt(prompt: string): void;
}

export default function EmptySessionWelcome({
  agentType,
  ready,
  connectionRequired = false,
  now,
  onSelectPrompt,
}: EmptySessionWelcomeProps) {
  const agentLabel = AGENT_LABELS[agentType];
  const greeting = welcomeGreetingForHour((now ?? new Date()).getHours());
  const prompt = connectionRequired ? "扫码连接电脑后，就能开始。" : ready ? greeting.prompt : "配置好 API Key 后，我就能开始。";
  const titleLength = Array.from(greeting.title).length;
  const promptLength = Array.from(prompt).length;
  const promptStart = titleLength + 3;
  const speakingTiming = {
    "--speech-title-length": titleLength,
    "--speech-prompt-length": promptLength,
    "--speech-prompt-start": promptStart,
    "--speech-title-beats": Math.round(titleLength / 3),
    "--speech-prompt-beats": Math.round(promptLength / 3),
  } as CSSProperties;

  return (
    <section className="empty-session-welcome" aria-labelledby="empty-session-welcome-title">
      <div className="empty-session-welcome__hero">
        <div className="empty-session-welcome__portrait" aria-hidden="true">
          <div className="empty-session-welcome__orbit" />
          <div className="empty-session-welcome__portrait-motion">
            <img className="empty-session-welcome__portrait-image" src={WELCOME_PORTRAIT} alt="" width={640} height={640} />
            <img className="empty-session-welcome__mouth" src={SPEAKING_MOUTH} alt="" width={200} height={150} style={speakingTiming} />
          </div>
        </div>
        <div className="empty-session-welcome__copy">
          <div className="empty-session-welcome__bubble">
            <h2 id="empty-session-welcome-title"><SpokenText text={greeting.title} /></h2>
            <p className="empty-session-welcome__prompt">
              <SpokenText text={prompt} start={promptStart} />
            </p>
          </div>
          <p className="empty-session-welcome__status">
            {connectionRequired ? `${agentLabel} · 等待连接` : ready ? `${agentLabel} · 已准备好` : `${agentLabel} · 等待配置`}
          </p>
        </div>
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
