import ctypes
import json
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from codec import AES, derive_base_key, page_key, page_iv, wal_checksum
from reader import decode_body, fields, committed_frames, prepare_mirror, read_batch, frozen_source


def varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def field(number, value):
    return varint((number << 3) | (2 if isinstance(value, bytes) else 0)) + (varint(len(value)) + value if isinstance(value, bytes) else varint(value))


def segment(kind, body):
    return field(1, field(1, kind) + field(2, body))


def body(text="请检查报错", vid=2**60 + 7):
    return segment(5, field(1, vid) + field(2, "本人".encode())) + segment(0, field(1, text.encode()))


def encrypt(aes, data, key, iv):
    output = ctypes.create_string_buffer(len(data))
    written = ctypes.c_size_t()
    code = aes.lib.CCCrypt(0, 0, 0, key, len(key), iv, data, len(data), output, len(data), ctypes.byref(written))
    if code != 0:
        raise RuntimeError("fixture encryption failed")
    return output.raw[:written.value]


def encrypted_page(aes, data, base, number):
    key, iv = page_key(base, number), page_iv(number)
    if number == 1:
        tail = encrypt(aes, data[16:], key, iv)
        return encrypt(aes, data[:16], key, iv)[:8] + tail[:8] + data[16:24] + tail[8:]
    return encrypt(aes, data, key, iv)


def encrypt_source(source, destination, vid):
    aes, base = AES(), derive_base_key(struct.pack("<Q", vid))
    data = source.read_bytes()
    size = int.from_bytes(data[16:18], "big")
    destination.write_bytes(b"".join(encrypted_page(aes, data[n:n+size], base, n // size + 1) for n in range(0, len(data), size)))
    wal = Path(str(source) + "-wal").read_bytes()
    result = bytearray(wal[:32])
    checksum = tuple(int.from_bytes(wal[n:n+4], "big") for n in (24, 28))
    order = next(o for o in ("little", "big") if wal_checksum(wal[:24], 0, 0, o) == checksum)
    for offset in range(32, len(wal), 24 + size):
        frame = bytearray(wal[offset:offset + 24 + size])
        if len(frame) != 24 + size:
            break
        page = int.from_bytes(frame[:4], "big")
        frame[24:] = encrypted_page(aes, bytes(frame[24:]), base, page)
        checksum = wal_checksum(bytes(frame[:8]), *checksum, order)
        checksum = wal_checksum(bytes(frame[24:]), *checksum, order)
        frame[16:24] = struct.pack(">II", *checksum)
        result.extend(frame)
    Path(str(destination) + "-wal").write_bytes(result)
    Path(str(destination) + "-shm").write_bytes(Path(str(source) + "-shm").read_bytes())


class ReaderTests(unittest.TestCase):
    def test_reads_all_segments_and_preserves_large_ids(self):
        mine = 2**60 + 7
        data = segment(0, field(1, b"before ")) + body(" after", mine) + segment(5, field(1, 42))
        decoded = decode_body(data)
        self.assertEqual(decoded["text"], "before  after")
        self.assertEqual(decoded["mentionTargets"], [str(mine), "42"])
        self.assertIn("@本人", decoded["displayText"])

    def test_quotes_extras_and_markdown_do_not_trigger_mentions(self):
        self.assertEqual(decode_body(segment(3, body()))["mentionTargets"], [])
        self.assertEqual(decode_body(body(vid=0))["mentionTargets"], ["0"])
        self.assertEqual(decode_body(body(), 80)["mentionTargets"], [])
        with self.assertRaises(ValueError):
            list(fields(bytes([10, 99, 1])))

    def fixture(self, directory):
        source = Path(directory) / "source.db"
        connection = sqlite3.connect(source)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("CREATE TABLE MESSAGE(LID INTEGER PRIMARY KEY,RID INTEGER,conv_id INTEGER,seq INTEGER,sender_id INTEGER,content_type INTEGER,send_time INTEGER,content BLOB,extras BLOB,refer INTEGER,flag INTEGER,message_type INTEGER)")
        connection.execute("CREATE TABLE CONVERSATION(RID INTEGER,name TEXT)")
        connection.execute("INSERT INTO CONVERSATION VALUES (12,'测试群')")
        connection.commit()
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        return source, connection

    def add_message(self, connection, lid, sent=20):
        connection.execute("INSERT INTO MESSAGE VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (lid, 2**60 + lid, 12, lid, 99, 0, sent, body(), b"", 0, 0, 0))
        connection.commit()

    def test_plain_source_activation_cursor_and_raw_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            source, connection = self.fixture(directory)
            try:
                self.add_message(connection, 1, 10)
                self.add_message(connection, 2, 20)
                config = {"database": str(source), "accountId": str(2**60 + 7), "cacheDir": str(Path(directory) / "cache"), "cursor": {"since": 15}}
                result = read_batch(config)
                self.assertEqual(len(result["messages"]), 1)
                self.assertEqual(result["messages"][0]["raw"]["RID"], str(2**60 + 2))
                self.assertTrue(result["messages"][0]["directMention"])
                config["cursor"] = result["cursor"]
                self.assertEqual(read_batch(config)["messages"], [])
            finally:
                connection.close()

    @unittest.skipUnless(sys.platform == "darwin", "CommonCrypto codec fixture")
    def test_encrypted_mirror_applies_only_new_committed_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            source, connection = self.fixture(directory)
            encrypted = Path(directory) / "encrypted.db"
            cache = Path(directory) / "cache"
            try:
                self.add_message(connection, 1)
                encrypt_source(source, encrypted, 777)
                mirror, generation, _ = prepare_mirror(encrypted, "777", cache)
                with sqlite3.connect(mirror) as clear:
                    self.assertEqual(clear.execute("SELECT COUNT(*) FROM MESSAGE").fetchone()[0], 1)
                self.add_message(connection, 2)
                # Only WAL changes in the live source after the baseline.
                other = Path(directory) / "next.db"
                encrypt_source(source, other, 777)
                Path(str(encrypted) + "-wal").write_bytes(Path(str(other) + "-wal").read_bytes() + b"incomplete trailing frame")
                from reader import decrypt_page
                with mock.patch("reader.decrypt_page", wraps=decrypt_page) as decrypt:
                    second, next_generation, _ = prepare_mirror(encrypted, "777", cache)
                    self.assertLess(decrypt.call_count, encrypted.stat().st_size // 4096)
                self.assertEqual(generation, next_generation)
                with sqlite3.connect(second) as clear:
                    self.assertEqual(clear.execute("SELECT COUNT(*) FROM MESSAGE").fetchone()[0], 2)
                data = Path(str(encrypted) + "-wal").read_bytes()
                frames, count, _ = committed_frames(data, 4096)
                self.assertEqual(count, len(frames))
                self.assertGreater(count, 0)
            finally:
                connection.close()

    def test_snapshot_locks_prevent_checkpoint_and_wal_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            source, connection = self.fixture(directory)
            self.add_message(connection, 1)
            connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
            initial_header = Path(str(source) + "-wal").read_bytes()[:24]
            original_copy = __import__("shutil").copyfile
            def copy_under_lock(src, dst):
                result = subprocess.run([sys.executable, "-c",
                    "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1],timeout=0); c.execute('INSERT INTO CONVERSATION VALUES (13,\"new\")'); c.commit(); print(json.dumps(c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone())); c.close()", str(source)], capture_output=True, text=True, check=True)
                self.assertEqual(json.loads(result.stdout)[0], 1)
                self.assertEqual(Path(str(source) + "-wal").read_bytes()[:24], initial_header)
                return original_copy(src, dst)
            try:
                with mock.patch("reader.sys.platform", "linux"), mock.patch("reader.shutil.copyfile", side_effect=copy_under_lock):
                    with frozen_source(source, directory) as (snapshot, _, _):
                        self.assertTrue(snapshot.is_file())
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
