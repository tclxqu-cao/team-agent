import { Brain } from "lucide-react";
import ElapsedTime from "./ElapsedTime";

interface AgentActivityIndicatorProps {
  startedAt: number;
}

export default function AgentActivityIndicator({ startedAt }: AgentActivityIndicatorProps) {
  return (
    <div className="agent-activity-indicator" role="status" aria-live="polite">
      <span className="agent-activity-icon" aria-hidden="true">
        <Brain size={17} strokeWidth={1.8} />
      </span>
      <span>思考中<ElapsedTime startedAt={startedAt} /></span>
    </div>
  );
}
