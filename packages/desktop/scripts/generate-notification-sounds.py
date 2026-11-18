#!/usr/bin/env python3
"""Generate AgentRoam's original notification tones as portable PCM WAV assets."""
from pathlib import Path
import math
import struct
import wave

SAMPLE_RATE = 44100
ROOT = Path(__file__).resolve().parents[1] / "assets" / "notification-sounds"
TONES = {
    "approval": [(0.00, 784, 0.30), (0.19, 1175, 0.34)],
    "completion": [(0.00, 523, 0.28), (0.12, 659, 0.28), (0.24, 784, 0.36)],
    "reminder": [(0.00, 988, 0.25), (0.31, 988, 0.30)],
    "scheduled": [(0.00, 554, 0.23), (0.10, 740, 0.23), (0.20, 932, 0.30)],
    "attention": [(0.00, 698, 0.28), (0.23, 587, 0.35)],
    "error": [(0.00, 440, 0.30), (0.19, 330, 0.30), (0.38, 262, 0.32)],
}


def generate(name, notes):
    duration = max(start + length for start, _, length in notes) + 0.08
    samples = []
    for index in range(math.ceil(duration * SAMPLE_RATE)):
        time = index / SAMPLE_RATE
        value = 0.0
        for start, frequency, length in notes:
            elapsed = time - start
            if not 0 <= elapsed < length:
                continue
            attack = min(1.0, elapsed / 0.007)
            release = min(1.0, (length - elapsed) / 0.06)
            envelope = attack * release * math.exp(-5.2 * elapsed / length)
            tone = (math.sin(2 * math.pi * frequency * elapsed)
                    + 0.22 * math.sin(2 * math.pi * frequency * 2.01 * elapsed)
                    + 0.07 * math.sin(2 * math.pi * frequency * 3.98 * elapsed))
            value += 0.42 * envelope * tone
        samples.append(max(-32767, min(32767, round(value * 32767))))
    with wave.open(str(ROOT / f"{name}.wav"), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(struct.pack(f"<{len(samples)}h", *samples))


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    for name, notes in TONES.items():
        generate(name, notes)
