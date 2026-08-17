#!/usr/bin/env python3
"""Persistent MLX-Audio TTS worker using a framed stdout protocol."""

from __future__ import annotations

import argparse
import json
import queue
import struct
import sys
import threading
import time
from collections.abc import Iterable
from typing import Any

JSON_FRAME = 0x01
PCM_FRAME = 0x02
SAMPLE_RATE = 24_000

_output_lock = threading.Lock()


def write_frame(kind: int, payload: bytes) -> None:
    with _output_lock:
        sys.stdout.buffer.write(struct.pack(">BI", kind, len(payload)))
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()


def write_json(value: dict[str, Any]) -> None:
    write_frame(JSON_FRAME, json.dumps(value, separators=(",", ":")).encode("utf-8"))


def float_to_s16le(samples: Iterable[float]) -> bytes:
    encoded = bytearray()
    for sample in samples:
        clipped = max(-1.0, min(1.0, float(sample)))
        value = -32768 if clipped <= -1.0 else min(32767, int(round(clipped * 32768.0)))
        encoded.extend(struct.pack("<h", value))
    return bytes(encoded)


class FakeModel:
    def generate(self, **_kwargs: Any):
        chunk_samples = int(SAMPLE_RATE * 0.04)
        for chunk_index in range(4):
            time.sleep(0.01)
            value = 0.1 if chunk_index % 2 == 0 else -0.1
            yield type("Result", (), {"audio": [value] * chunk_samples})()


def load_mlx_model(model_name: str):
    from mlx_audio.tts.utils import load_model

    return load_model(model_name)


def audio_samples(audio: Any) -> Iterable[float]:
    try:
        import mlx.core as mx

        mx.eval(audio)
    except (ImportError, TypeError):
        pass
    if hasattr(audio, "tolist"):
        audio = audio.tolist()
    while isinstance(audio, list) and len(audio) == 1 and isinstance(audio[0], list):
        audio = audio[0]
    return audio


class Worker:
    def __init__(self, model: Any):
        self.model = model
        self.commands: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=2)
        self.cancelled_ids: set[str] = set()
        self.active_id: str | None = None
        self.active_cancel: threading.Event | None = None
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._run, name="mlx-tts-synthesis", daemon=True)
        self.thread.start()

    def submit(self, command: dict[str, Any]) -> None:
        request_id = command.get("requestId")
        if not isinstance(request_id, str) or not request_id:
            raise ValueError("requestId must be a non-empty string")
        text = command.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text must be a non-empty string")
        with self.lock:
            if self.active_cancel is not None:
                self.active_cancel.set()
        try:
            self.commands.put_nowait(command)
        except queue.Full as error:
            raise RuntimeError("worker command queue is full") from error

    def cancel(self, request_id: str) -> None:
        with self.lock:
            self.cancelled_ids.add(request_id)
            if request_id == self.active_id and self.active_cancel is not None:
                self.active_cancel.set()

    def close(self) -> None:
        with self.lock:
            if self.active_cancel is not None:
                self.active_cancel.set()
        self.commands.put(None)
        self.thread.join(timeout=5)

    def _run(self) -> None:
        while True:
            command = self.commands.get()
            if command is None:
                return
            self._synthesize(command)

    def _synthesize(self, command: dict[str, Any]) -> None:
        request_id = command["requestId"]
        cancel = threading.Event()
        with self.lock:
            self.active_id = request_id
            self.active_cancel = cancel
            if request_id in self.cancelled_ids:
                cancel.set()
        if cancel.is_set():
            write_json({"type": "cancelled", "requestId": request_id})
            self._clear_active(request_id)
            return
        try:
            write_json({
                "type": "started",
                "requestId": request_id,
                "sampleRate": SAMPLE_RATE,
                "channels": 1,
                "sampleFormat": "s16le",
            })
            results = self.model.generate(
                text=command["text"],
                voice=command.get("voice", "Serena"),
                language="Chinese",
                speed=command.get("speed", 1.0),
                stream=True,
                streaming_interval=command.get("streamingInterval", 0.32),
            )
            for result in results:
                if cancel.is_set():
                    write_json({"type": "cancelled", "requestId": request_id})
                    return
                pcm = float_to_s16le(audio_samples(result.audio))
                if pcm:
                    write_frame(PCM_FRAME, pcm)
            terminal = "cancelled" if cancel.is_set() else "finished"
            write_json({"type": terminal, "requestId": request_id})
        except Exception as error:  # worker errors must cross the process boundary
            write_json({"type": "error", "requestId": request_id, "message": str(error)})
        finally:
            self._clear_active(request_id)

    def _clear_active(self, request_id: str) -> None:
        with self.lock:
            self.cancelled_ids.discard(request_id)
            if self.active_id == request_id:
                self.active_id = None
                self.active_cancel = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=False, default="mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit")
    parser.add_argument("--fake", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        model = FakeModel() if args.fake else load_mlx_model(args.model)
    except Exception as error:
        write_json({"type": "startup-error", "message": str(error)})
        return 1
    worker = Worker(model)
    write_json({"type": "ready"})
    try:
        for line in sys.stdin:
            try:
                command = json.loads(line)
                kind = command.get("type")
                if kind == "synthesize":
                    worker.submit(command)
                elif kind == "cancel":
                    worker.cancel(str(command.get("requestId", "")))
                elif kind == "shutdown":
                    break
                else:
                    raise ValueError("unsupported command type")
            except Exception as error:
                write_json({"type": "command-error", "message": str(error)})
    finally:
        worker.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
