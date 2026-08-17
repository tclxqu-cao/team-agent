import json
import pathlib
import struct
import subprocess
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from mlx_tts_worker import PCM_FRAME, float_to_s16le, generation_max_tokens, warmup_model


def read_frame(stream):
    header = stream.read(5)
    if len(header) != 5:
        raise EOFError("missing frame header")
    kind, length = struct.unpack(">BI", header)
    payload = stream.read(length)
    if len(payload) != length:
        raise EOFError("missing frame payload")
    return kind, payload


class WorkerTest(unittest.TestCase):
    def test_float_pcm_is_clipped_and_encoded_little_endian(self):
        pcm = float_to_s16le([-2.0, -0.5, 0.5, 2.0])
        self.assertEqual(struct.unpack("<hhhh", pcm), (-32768, -16384, 16384, 32767))

    def test_warmup_model_consumes_a_chinese_stream(self):
        class RecordingModel:
            def __init__(self):
                self.options = None
                self.chunks = 0
                self.closed = False

            def generate(inner_self, **options):
                inner_self.options = options
                try:
                    while True:
                        inner_self.chunks += 1
                        yield type("Result", (), {"audio": [0.0, 0.25]})()
                finally:
                    inner_self.closed = True

        model = RecordingModel()
        warmup_model(model)

        self.assertEqual(model.chunks, 1)
        self.assertTrue(model.closed)
        self.assertEqual(model.options["lang_code"], "chinese")
        self.assertTrue(model.options["stream"])

    def test_generation_token_limit_is_bounded_by_text_size(self):
        class Tokenizer:
            def encode(self, text):
                return list(text)

        model = type("Model", (), {"tokenizer": Tokenizer()})()
        self.assertEqual(generation_max_tokens(model, "你好"), 75)
        self.assertEqual(generation_max_tokens(model, "字" * 100), 400)
        self.assertEqual(generation_max_tokens(model, "字" * 1_000), 1_200)

    def test_fake_worker_streams_pcm_and_finishes(self):
        script = pathlib.Path(__file__).with_name("mlx_tts_worker.py")
        process = subprocess.Popen(
            [sys.executable, str(script), "--fake"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        def cleanup():
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()

        self.addCleanup(cleanup)
        kind, payload = read_frame(process.stdout)
        self.assertEqual(json.loads(payload), {"type": "ready"})
        command = {
            "type": "synthesize",
            "requestId": "test-1",
            "text": "你好",
            "voice": "Serena",
            "speed": 1,
            "streamingInterval": 0.32,
        }
        process.stdin.write((json.dumps(command) + "\n").encode())
        process.stdin.flush()
        messages = []
        pcm_frames = 0
        while not any(message.get("type") == "finished" for message in messages):
            frame_kind, frame_payload = read_frame(process.stdout)
            if frame_kind == PCM_FRAME:
                pcm_frames += 1
            else:
                messages.append(json.loads(frame_payload))
        self.assertEqual(messages[0]["type"], "started")
        self.assertEqual(messages[-1], {"type": "finished", "requestId": "test-1"})
        self.assertGreater(pcm_frames, 0)
        process.stdin.write(b'{"type":"shutdown"}\n')
        process.stdin.flush()
        self.assertEqual(process.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
