import { useEffect, useRef, useState, useCallback } from "react";

// ── Types ──
type Point = { x: number; y: number };
type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";

const COLS = 20;
const ROWS = 20;
const CELL = 20; // px per cell
const CANVAS_SIZE = 400;
const MOVE_INTERVAL = 150; // ms per move
const HIGH_SCORE_KEY = "snake_high_score";

const DIRECTION_VECTORS: Record<Direction, Point> = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

const OPPOSITE: Record<Direction, Direction> = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
};

// ── Helpers ──
function randomFood(snake: Point[]): Point {
  const occupied = new Set(snake.map((p) => `${p.x},${p.y}`));
  const available: Point[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!occupied.has(`${x},${y}`)) available.push({ x, y });
    }
  }
  if (available.length === 0) return { x: 0, y: 0 }; // fallback
  return available[Math.floor(Math.random() * available.length)];
}

function getHighScore(): number {
  try {
    return parseInt(localStorage.getItem(HIGH_SCORE_KEY) ?? "0", 10) || 0;
  } catch {
    return 0;
  }
}

function setHighScore(score: number) {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(score));
  } catch {
    // ignore
  }
}

// ── Component ──
interface SnakeGameProps {
  onBack?: () => void;
}

export default function SnakeGame({ onBack }: SnakeGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Game state
  const [gameState, setGameState] = useState<"idle" | "playing" | "over">("idle");
  const [score, setScore] = useState(0);
  const [highScore, setHighScoreState] = useState(getHighScore);

  // Mutable refs for game loop (avoid stale closures)
  const snakeRef = useRef<Point[]>([{ x: 10, y: 10 }]);
  const foodRef = useRef<Point>({ x: 15, y: 10 });
  const directionRef = useRef<Direction>("RIGHT");
  const nextDirectionRef = useRef<Direction>("RIGHT");
  const scoreRef = useRef(0);
  const lastMoveRef = useRef(0);
  const animFrameRef = useRef(0);
  const gameStateRef = useRef<"idle" | "playing" | "over">("idle");

  // ── Drawing ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = CANVAS_SIZE;
    const h = CANVAS_SIZE;

    // Background
    ctx.fillStyle = "var(--bg-surface, #ffffff)";
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = "var(--border-subtle, #e8e8ed)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL, 0);
      ctx.lineTo(x * CELL, h);
      ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL);
      ctx.lineTo(w, y * CELL);
      ctx.stroke();
    }

    // Food
    const food = foodRef.current;
    const foodCx = food.x * CELL + CELL / 2;
    const foodCy = food.y * CELL + CELL / 2;
    ctx.fillStyle = "var(--danger, #dc2626)";
    ctx.beginPath();
    ctx.arc(foodCx, foodCy, CELL / 2 - 2, 0, Math.PI * 2);
    ctx.fill();

    // Snake
    const snake = snakeRef.current;
    const accent = getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#4f6ef7";
    const accentDim =
      getComputedStyle(canvas).getPropertyValue("--accent-dim").trim() || "rgba(79,110,247,0.09)";

    snake.forEach((seg, i) => {
      const px = seg.x * CELL;
      const py = seg.y * CELL;
      const r = 4;
      const pad = 1;

      // Head
      if (i === 0) {
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(px + pad + r, py + pad);
        ctx.lineTo(px + CELL - pad - r, py + pad);
        ctx.quadraticCurveTo(px + CELL - pad, py + pad, px + CELL - pad, py + pad + r);
        ctx.lineTo(px + CELL - pad, py + CELL - pad - r);
        ctx.quadraticCurveTo(px + CELL - pad, py + CELL - pad, px + CELL - pad - r, py + CELL - pad);
        ctx.lineTo(px + pad + r, py + CELL - pad);
        ctx.quadraticCurveTo(px + pad, py + CELL - pad, px + pad, py + CELL - pad - r);
        ctx.lineTo(px + pad, py + pad + r);
        ctx.quadraticCurveTo(px + pad, py + pad, px + pad + r, py + pad);
        ctx.closePath();
        ctx.fill();

        // Eyes
        const dir = directionRef.current;
        let eye1: Point, eye2: Point;
        const eyeR = 2.5;
        const pupilR = 1.2;
        if (dir === "RIGHT") {
          eye1 = { x: px + CELL - 6, y: py + 6 };
          eye2 = { x: px + CELL - 6, y: py + CELL - 6 };
        } else if (dir === "LEFT") {
          eye1 = { x: px + 6, y: py + 6 };
          eye2 = { x: px + 6, y: py + CELL - 6 };
        } else if (dir === "UP") {
          eye1 = { x: px + 6, y: py + 6 };
          eye2 = { x: px + CELL - 6, y: py + 6 };
        } else {
          eye1 = { x: px + 6, y: py + CELL - 6 };
          eye2 = { x: px + CELL - 6, y: py + CELL - 6 };
        }
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(eye1.x, eye1.y, eyeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(eye2.x, eye2.y, eyeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1a1a2e";
        ctx.beginPath();
        ctx.arc(eye1.x, eye1.y, pupilR, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(eye2.x, eye2.y, pupilR, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Body segment
        const alpha = 1 - (i / snake.length) * 0.5;
        ctx.fillStyle = accent;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(px + pad + r, py + pad);
        ctx.lineTo(px + CELL - pad - r, py + pad);
        ctx.quadraticCurveTo(px + CELL - pad, py + pad, px + CELL - pad, py + pad + r);
        ctx.lineTo(px + CELL - pad, py + CELL - pad - r);
        ctx.quadraticCurveTo(px + CELL - pad, py + CELL - pad, px + CELL - pad - r, py + CELL - pad);
        ctx.lineTo(px + pad + r, py + CELL - pad);
        ctx.quadraticCurveTo(px + pad, py + CELL - pad, px + pad, py + CELL - pad - r);
        ctx.lineTo(px + pad, py + pad + r);
        ctx.quadraticCurveTo(px + pad, py + pad, px + pad + r, py + pad);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    });

    // Game Over overlay
    if (gameStateRef.current === "over") {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#fff";
      ctx.font = "600 28px var(--font-body, Inter, sans-serif)";
      ctx.textAlign = "center";
      ctx.fillText("游戏结束", w / 2, h / 2 - 8);
      ctx.font = "400 14px var(--font-body, Inter, sans-serif)";
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText(`得分: ${scoreRef.current}`, w / 2, h / 2 + 24);
    }

    // Idle overlay
    if (gameStateRef.current === "idle") {
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "var(--text-primary, #1a1a2e)";
      ctx.font = "600 22px var(--font-body, Inter, sans-serif)";
      ctx.textAlign = "center";
      ctx.fillText("🐍 贪吃蛇", w / 2, h / 2 - 8);
      ctx.font = "400 13px var(--font-body, Inter, sans-serif)";
      ctx.fillStyle = "var(--text-secondary, #6b7280)";
      ctx.fillText("点击「开始游戏」按钮", w / 2, h / 2 + 22);
    }
  }, []);

  // ── Game loop ──
  const gameLoop = useCallback(
    (timestamp: number) => {
      if (gameStateRef.current !== "playing") {
        draw();
        return;
      }

      if (timestamp - lastMoveRef.current >= MOVE_INTERVAL) {
        lastMoveRef.current = timestamp;

        // Apply queued direction
        directionRef.current = nextDirectionRef.current;

        const head = snakeRef.current[0];
        const vec = DIRECTION_VECTORS[directionRef.current];
        const newHead: Point = { x: head.x + vec.x, y: head.y + vec.y };

        // Wall collision
        if (newHead.x < 0 || newHead.x >= COLS || newHead.y < 0 || newHead.y >= ROWS) {
          gameStateRef.current = "over";
          setGameState("over");
          const finalScore = scoreRef.current;
          const hs = getHighScore();
          if (finalScore > hs) {
            setHighScore(finalScore);
            setHighScoreState(finalScore);
          }
          draw();
          return;
        }

        // Self collision (ignore tail if not growing)
        const willGrow = newHead.x === foodRef.current.x && newHead.y === foodRef.current.y;
        const checkBody = willGrow ? snakeRef.current : snakeRef.current.slice(0, -1);
        if (checkBody.some((p) => p.x === newHead.x && p.y === newHead.y)) {
          gameStateRef.current = "over";
          setGameState("over");
          const finalScore = scoreRef.current;
          const hs = getHighScore();
          if (finalScore > hs) {
            setHighScore(finalScore);
            setHighScoreState(finalScore);
          }
          draw();
          return;
        }

        // Move
        const newSnake = [newHead, ...snakeRef.current];
        if (willGrow) {
          foodRef.current = randomFood(newSnake);
          scoreRef.current += 10;
          setScore(scoreRef.current);
        } else {
          newSnake.pop();
        }
        snakeRef.current = newSnake;
      }

      draw();
      animFrameRef.current = requestAnimationFrame(gameLoop);
    },
    [draw]
  );

  // ── Start / Restart ──
  const startGame = useCallback(() => {
    const initialSnake = [{ x: 10, y: 10 }];
    snakeRef.current = initialSnake;
    foodRef.current = randomFood(initialSnake);
    directionRef.current = "RIGHT";
    nextDirectionRef.current = "RIGHT";
    scoreRef.current = 0;
    lastMoveRef.current = 0;
    gameStateRef.current = "playing";

    setScore(0);
    setGameState("playing");

    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = requestAnimationFrame(gameLoop);
  }, [gameLoop]);

  // ── Keyboard ──
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (gameStateRef.current !== "playing") return;

      let newDir: Direction | null = null;
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") newDir = "UP";
      else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") newDir = "DOWN";
      else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") newDir = "LEFT";
      else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") newDir = "RIGHT";

      if (newDir && newDir !== OPPOSITE[directionRef.current]) {
        nextDirectionRef.current = newDir;
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // ── Cleanup on unmount ──
  useEffect(() => {
    draw(); // initial draw
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [draw]);

  // ── Render ──
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        padding: "24px 20px",
        fontFamily: "var(--font-body, Inter, sans-serif)",
        height: "100%",
        overflow: "auto",
      }}
    >
      {/* Header row */}
      <div
        style={{
          width: "100%",
          maxWidth: CANVAS_SIZE,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {/* Back button */}
        {onBack && (
          <button
            onClick={onBack}
            title="返回"
            style={{
              width: 32,
              height: 32,
              border: "none",
              borderRadius: "var(--radius-sm, 6px)",
              background: "transparent",
              color: "var(--text-muted, #9ca3af)",
              fontSize: 18,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background 0.15s var(--ease-out, ease), color 0.15s var(--ease-out, ease)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim, rgba(79,110,247,0.09))";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--accent, #4f6ef7)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted, #9ca3af)";
            }}
          >
            ←
          </button>
        )}

        {/* Score display */}
        <div style={{ display: "flex", gap: 20, alignItems: "center", marginLeft: onBack ? 0 : "auto" }}>
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted, #9ca3af)",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              分数
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: "var(--text-primary, #1a1a2e)",
                fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)",
                lineHeight: 1.2,
              }}
            >
              {score}
            </div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted, #9ca3af)",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              最高分
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: "var(--accent, #4f6ef7)",
                fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)",
                lineHeight: 1.2,
              }}
            >
              {highScore}
            </div>
          </div>
        </div>
      </div>

      {/* Canvas */}
      <div
        style={{
          borderRadius: "var(--radius-md, 10px)",
          boxShadow: "var(--shadow-md, 0 4px 16px rgba(0,0,0,0.08))",
          overflow: "hidden",
          border: "1px solid var(--border-subtle, #e8e8ed)",
          lineHeight: 0,
        }}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          style={{ display: "block" }}
        />
      </div>

      {/* Buttons */}
      <div style={{ display: "flex", gap: 10, maxWidth: CANVAS_SIZE, width: "100%" }}>
        {gameState === "idle" && (
          <button
            onClick={startGame}
            style={{
              flex: 1,
              padding: "10px 20px",
              borderRadius: "var(--radius-sm, 8px)",
              border: "none",
              background: "var(--accent, #4f6ef7)",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              transition: "background 0.15s var(--ease-out, ease), box-shadow 0.15s var(--ease-out, ease)",
              boxShadow: "var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.08))",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "#3d5bd9";
              (e.currentTarget as HTMLButtonElement).style.boxShadow =
                "var(--shadow-md, 0 4px 16px rgba(0,0,0,0.08))";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--accent, #4f6ef7)";
              (e.currentTarget as HTMLButtonElement).style.boxShadow =
                "var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.08))";
            }}
          >
            开始游戏
          </button>
        )}

        {gameState === "over" && (
          <button
            onClick={startGame}
            style={{
              flex: 1,
              padding: "10px 20px",
              borderRadius: "var(--radius-sm, 8px)",
              border: "none",
              background: "var(--accent, #4f6ef7)",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              transition: "background 0.15s var(--ease-out, ease), box-shadow 0.15s var(--ease-out, ease)",
              boxShadow: "var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.08))",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "#3d5bd9";
              (e.currentTarget as HTMLButtonElement).style.boxShadow =
                "var(--shadow-md, 0 4px 16px rgba(0,0,0,0.08))";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--accent, #4f6ef7)";
              (e.currentTarget as HTMLButtonElement).style.boxShadow =
                "var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.08))";
            }}
          >
            重新开始
          </button>
        )}

        {gameState === "playing" && (
          <button
            onClick={startGame}
            style={{
              flex: 1,
              padding: "10px 20px",
              borderRadius: "var(--radius-sm, 8px)",
              border: "1px solid var(--border-default, #d1d5db)",
              background: "transparent",
              color: "var(--text-secondary, #6b7280)",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
              transition: "background 0.15s var(--ease-out, ease), color 0.15s var(--ease-out, ease)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim, rgba(79,110,247,0.09))";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--accent, #4f6ef7)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-secondary, #6b7280)";
            }}
          >
            重新开始
          </button>
        )}
      </div>

      {/* Controls hint */}
      <div
        style={{
          fontSize: 12,
          color: "var(--text-muted, #9ca3af)",
          textAlign: "center",
          lineHeight: 1.6,
        }}
      >
        方向键 / WASD 控制移动
      </div>
    </div>
  );
}