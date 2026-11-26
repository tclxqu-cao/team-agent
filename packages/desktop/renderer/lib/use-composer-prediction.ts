import { useEffect, useRef, useState } from "react";
import { followUpFromReply } from "./composer-prediction";

interface PredictionTurn {
  sessionId: string;
  turnId: string;
  reply: string;
}

export function useComposerPrediction(sessionId: string | null, eligible: boolean) {
  const [turn, setTurn] = useState<PredictionTurn | null>(null);
  const [result, setResult] = useState<{ turn: PredictionTurn; text: string | null } | null>(null);
  const lastOffered = useRef<{ sessionId: string; turnId: string } | null>(null);
  const currentTurn = turn?.sessionId === sessionId ? turn : null;

  useEffect(() => {
    setTurn(previous => previous?.sessionId === sessionId ? previous : null);
  }, [sessionId]);

  useEffect(() => {
    if (!currentTurn || !eligible || result?.turn === currentTurn) return;
    const controller = new AbortController();
    const fallback = followUpFromReply(currentTurn.reply);
    const prediction = window.agentApi?.requestComposerPrediction?.(currentTurn.sessionId, currentTurn.turnId, controller.signal);
    void Promise.resolve(prediction).catch(() => null).then(text => {
      if (!controller.signal.aborted) setResult({ turn: currentTurn, text: text || fallback });
    });
    return () => controller.abort();
  }, [currentTurn, eligible, result]);

  return {
    text: eligible && currentTurn && result?.turn === currentTurn ? result.text : null,
    offer: (next: PredictionTurn) => {
      if (lastOffered.current?.sessionId === next.sessionId && lastOffered.current.turnId === next.turnId) return;
      lastOffered.current = next;
      setTurn(next);
    },
    dismiss: () => setTurn(null),
  };
}
