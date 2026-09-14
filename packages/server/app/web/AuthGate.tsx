"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Monitor } from "lucide-react";
import { useWebAuth } from "./useWebAuth";

export type WebAuthController = ReturnType<typeof useWebAuth>;

export function connectionElapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

/** Pairing is enforced by the gateway; wait for the authorized console bootstrap. */
export default function AuthGate({ children }: { children: (auth: WebAuthController) => ReactNode }) {
  const auth = useWebAuth();
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (auth.status !== "loading" || auth.error) return;
    const phaseStartedAt = Date.now();
    setStartedAt(phaseStartedAt);
    setNow(phaseStartedAt);
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [auth.error, auth.status]);

  if (auth.status === "authenticated") return <>{children(auth)}</>;
  const connecting = !auth.error;
  return (
    <main className={`remote-gate${connecting ? " is-connecting" : " is-error"}`}>
      <div className="remote-grid" aria-hidden="true" />
      <div className="remote-stream remote-stream-left" aria-hidden="true" />
      <div className="remote-stream remote-stream-right" aria-hidden="true" />
      <div className="remote-content">
        <div className="remote-scene" aria-hidden="true">
          <div className="remote-beam" />
          <div className="remote-pulse remote-pulse-one" />
          <div className="remote-pulse remote-pulse-two" />
          <div className="remote-device">
            <div className="remote-device-back" />
            <div className="remote-screen">
              <div className="remote-screen-scan" />
              <Monitor size={44} strokeWidth={1.25} />
            </div>
            <div className="remote-device-stand" />
          </div>
        </div>
        <div
          className="remote-status"
          role={connecting ? "status" : "alert"}
          aria-label={connecting ? "正在连接远程控制台" : auth.error || undefined}
        >
          <Monitor size={20} strokeWidth={1.8} aria-hidden="true" />
          <span>{auth.error || "远程连接中"}</span>
          {connecting && (
            <span className="remote-elapsed" aria-hidden="true">
              · 已持续 {connectionElapsedSeconds(startedAt, now)} 秒
            </span>
          )}
        </div>
      </div>
      <style jsx>{`
        .remote-gate {
          position: relative;
          min-height: 100dvh;
          display: grid;
          place-items: center;
          overflow: hidden;
          background:
            linear-gradient(118deg, rgba(45, 112, 124, 0.2), transparent 31%),
            linear-gradient(248deg, rgba(48, 112, 87, 0.17), transparent 34%),
            rgba(7, 10, 14, 0.92);
          backdrop-filter: blur(8px) saturate(1.12);
          -webkit-backdrop-filter: blur(8px) saturate(1.12);
          color: #e8e8ee;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .remote-gate::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-image:
            linear-gradient(rgba(91, 220, 194, 0.045) 1px, transparent 1px),
            linear-gradient(90deg, rgba(102, 166, 255, 0.045) 1px, transparent 1px);
          background-size: 56px 56px;
          mask-image: linear-gradient(to bottom, transparent 5%, #000 48%, transparent 100%);
          opacity: 0.82;
        }

        .remote-grid {
          position: absolute;
          left: -22%;
          right: -22%;
          bottom: -28%;
          height: 70%;
          transform: perspective(440px) rotateX(64deg);
          transform-origin: center bottom;
          background-image:
            linear-gradient(rgba(95, 220, 196, 0.16) 1px, transparent 1px),
            linear-gradient(90deg, rgba(101, 165, 255, 0.14) 1px, transparent 1px);
          background-size: 46px 46px;
          mask-image: linear-gradient(to bottom, transparent 4%, #000 60%, transparent 96%);
          opacity: 0.72;
        }

        .remote-stream {
          position: absolute;
          top: -12%;
          width: 1px;
          height: 124%;
          background: linear-gradient(to bottom, transparent, rgba(96, 222, 196, 0.5), transparent 72%);
          opacity: 0.55;
          transform: rotate(18deg);
          transform-origin: top;
        }

        .remote-stream::after {
          content: "";
          position: absolute;
          left: -2px;
          top: 24%;
          width: 5px;
          height: 54px;
          background: linear-gradient(to bottom, transparent, #8cf3dd, transparent);
          filter: blur(1px);
          animation: streamFlow 2.6s linear infinite;
        }

        .remote-stream-left { left: 16%; }
        .remote-stream-right { right: 18%; transform: rotate(-15deg); }
        .remote-stream-right::after { animation-delay: -1.3s; }

        .remote-content {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 24px;
        }

        .remote-scene {
          position: relative;
          width: 220px;
          height: 154px;
          perspective: 520px;
          transform-style: preserve-3d;
        }

        .remote-beam {
          position: absolute;
          left: 50%;
          top: 50%;
          width: 184px;
          height: 2px;
          transform: translate(-50%, -50%) rotateX(68deg);
          background: linear-gradient(90deg, transparent, rgba(118, 177, 255, 0.86), #8cf3dd, transparent);
          box-shadow: 0 0 16px rgba(105, 222, 205, 0.5);
          animation: beamConnect 1.8s ease-in-out infinite;
        }

        .remote-pulse {
          position: absolute;
          left: 50%;
          top: 47%;
          width: 132px;
          height: 86px;
          border: 1px solid rgba(112, 231, 207, 0.42);
          border-radius: 8px;
          transform: translate(-50%, -50%) rotateY(-12deg) rotateX(4deg) translateZ(-20px);
          opacity: 0;
          animation: signalPulse 2.4s ease-out infinite;
        }

        .remote-pulse-two { animation-delay: 1.2s; }

        .remote-device {
          position: absolute;
          left: 50%;
          top: 50%;
          width: 136px;
          height: 108px;
          transform-style: preserve-3d;
          transform: translate(-50%, -50%) rotateY(-12deg) rotateX(4deg);
          animation: deviceFloat 3.2s ease-in-out infinite;
        }

        .remote-device-back {
          position: absolute;
          inset: 3px 2px 17px 7px;
          border: 1px solid rgba(118, 177, 255, 0.2);
          border-radius: 7px;
          background: rgba(14, 18, 27, 0.68);
          transform: translateZ(-12px) translate(7px, 6px);
        }

        .remote-screen {
          position: absolute;
          inset: 0 0 18px;
          display: grid;
          place-items: center;
          overflow: hidden;
          border: 1px solid rgba(132, 232, 215, 0.58);
          border-radius: 7px;
          background: rgba(10, 15, 22, 0.76);
          color: #9bf4e3;
          box-shadow:
            inset 0 0 24px rgba(86, 205, 185, 0.08),
            0 14px 34px rgba(0, 0, 0, 0.28),
            0 0 24px rgba(80, 208, 185, 0.14);
          transform: translateZ(8px);
        }

        .remote-screen::before {
          content: "";
          position: absolute;
          inset: 7px;
          border: 1px solid rgba(116, 174, 255, 0.13);
          border-radius: 3px;
        }

        .remote-screen-scan {
          position: absolute;
          left: 9px;
          right: 9px;
          height: 1px;
          background: #8cf3dd;
          box-shadow: 0 0 8px rgba(140, 243, 221, 0.85);
          animation: screenScan 2s ease-in-out infinite;
        }

        .remote-device-stand {
          position: absolute;
          left: 50%;
          bottom: 4px;
          width: 44px;
          height: 14px;
          border-bottom: 2px solid rgba(147, 183, 202, 0.55);
          transform: translateX(-50%) translateZ(4px) skewX(-14deg);
        }

        .remote-device-stand::before {
          content: "";
          position: absolute;
          left: 50%;
          top: -5px;
          width: 2px;
          height: 9px;
          background: rgba(147, 183, 202, 0.55);
        }

        .remote-status {
          min-height: 24px;
          display: flex;
          align-items: center;
          gap: 8px;
          color: #cbd2dc;
          font-size: 13px;
          line-height: 20px;
          text-shadow: 0 1px 10px rgba(0, 0, 0, 0.45);
        }

        .remote-elapsed {
          color: #9ca6b6;
          font-size: 12px;
        }

        .is-error .remote-screen,
        .is-error .remote-status {
          color: #e2a5a5;
          border-color: rgba(226, 165, 165, 0.4);
        }

        .is-error .remote-screen-scan,
        .is-error .remote-beam,
        .is-error .remote-pulse,
        .is-error .remote-stream::after,
        .is-error .remote-device {
          animation: none;
        }

        @keyframes deviceFloat {
          0%, 100% { transform: translate(-50%, -50%) rotateY(-12deg) rotateX(4deg) translateY(0); }
          50% { transform: translate(-50%, -50%) rotateY(-8deg) rotateX(2deg) translateY(-6px); }
        }

        @keyframes signalPulse {
          0% { opacity: 0; transform: translate(-50%, -50%) rotateY(-12deg) rotateX(4deg) translateZ(-18px) scale(0.82); }
          28% { opacity: 0.58; }
          100% { opacity: 0; transform: translate(-50%, -50%) rotateY(-12deg) rotateX(4deg) translateZ(-42px) scale(1.5); }
        }

        @keyframes screenScan {
          0%, 100% { top: 18%; opacity: 0.24; }
          50% { top: 80%; opacity: 0.82; }
        }

        @keyframes beamConnect {
          0%, 100% { opacity: 0.24; transform: translate(-50%, -50%) rotateX(68deg) scaleX(0.7); }
          50% { opacity: 0.9; transform: translate(-50%, -50%) rotateX(68deg) scaleX(1); }
        }

        @keyframes streamFlow {
          from { transform: translateY(-90px); opacity: 0; }
          30%, 70% { opacity: 0.9; }
          to { transform: translateY(460px); opacity: 0; }
        }

        @media (prefers-reduced-motion: reduce) {
          .remote-gate *,
          .remote-gate *::before,
          .remote-gate *::after {
            animation: none !important;
          }
        }
      `}</style>
    </main>
  );
}
