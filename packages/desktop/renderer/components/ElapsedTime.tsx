import { useEffect, useState } from "react";

interface ElapsedTimeProps {
  startedAt: number;
}

export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

export default function ElapsedTime({ startedAt }: ElapsedTimeProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return <span className="activity-elapsed-time"> · 持续了 {elapsedSeconds(startedAt, now)} 秒</span>;
}
