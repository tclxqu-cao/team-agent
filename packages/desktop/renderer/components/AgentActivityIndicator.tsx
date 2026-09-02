export default function AgentActivityIndicator() {
  return (
    <div className="agent-activity-indicator" role="status" aria-live="polite">
      <span>思考中</span>
      <span className="agent-activity-dots" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span key={index} style={{ animationDelay: `${index * 0.16}s` }} />
        ))}
      </span>
    </div>
  );
}
