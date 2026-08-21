export type AgentActivityPhase = "thinking" | "tools";

export default function AgentActivityIndicator({
  activity,
}: {
  activity: AgentActivityPhase;
}) {
  const label = activity === "tools" ? "工具执行中" : "思考中";

  return (
    <div className="agent-activity-indicator" role="status" aria-live="polite">
      <span>{label}</span>
      <span className="agent-activity-dots" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span key={index} style={{ animationDelay: `${index * 0.16}s` }} />
        ))}
      </span>
    </div>
  );
}
