import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface WakeOverlayProps {
  /** 触发一次动画（每次值变化都重播） */
  trigger: number;
  /** 唤醒时听到的原话（可选展示） */
  heardText?: string;
}

/**
 * Full-screen wake-up animation: expanding rings around a glowing core.
 * Rendered on demand via a portal; auto-dismisses after ~2.4s.
 */
export default function WakeOverlay({ trigger, heardText }: WakeOverlayProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (trigger <= 0) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2400);
    return () => clearTimeout(t);
  }, [trigger]);

  if (!visible) return null;

  return createPortal(
    <div
      key={trigger}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 30000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        background: "radial-gradient(circle at 50% 50%, var(--accent-glow), transparent 60%)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        animation: "fadeIn 0.3s var(--ease-out)",
        pointerEvents: "none",
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      {/* Rings + core */}
      <div style={{ position: "relative", width: 120, height: 120 }}>
        {[0, 0.45, 0.9].map((delay) => (
          <div
            key={delay}
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: "2px solid var(--accent)",
              animation: `wakeRing 1.6s ${delay}s var(--ease-out) infinite`,
            }}
          />
        ))}
        <div
          style={{
            position: "absolute",
            inset: 30,
            borderRadius: "50%",
            background: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            animation: "wakeCore 1.6s var(--ease-out) infinite",
          }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--text-inverse)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        </div>
      </div>

      <div style={{
        fontSize: 16,
        fontWeight: 600,
        color: "var(--text-primary)",
        letterSpacing: "0.12em",
        animation: "wakeText 0.9s var(--ease-out) both",
        fontFamily: "var(--font-display)",
      }}>
        已唤醒 · 随时待命
      </div>
      {heardText && (
        <div style={{
          fontSize: 12,
          color: "var(--text-muted)",
          maxWidth: 320,
          textAlign: "center",
          animation: "fadeIn 0.6s var(--ease-out) 0.3s both",
        }}>
          “{heardText.slice(0, 40)}”
        </div>
      )}
    </div>,
    document.body,
  );
}
