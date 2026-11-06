import json
import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest import mock

from native_sender import Blocked, NativeBridge, process, resolve_request, verify_client_database


def varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    return bytes(result + bytes([value]))


def field(number, value):
    return varint(number * 8 + 2) + varint(len(value)) + value


def body(text):
    return field(1, b"\x08\x00" + field(2, field(1, text.encode())))


TITLE = "蔡正银(zhengyin.cai)"


class FakeBridge:
    def __init__(self, draft="", header_after_paste=TITLE, interrupt=None):
        self.draft, self.header, self.header_after_paste = draft, TITLE, header_after_paste
        self.interrupt = interrupt
        self.calls = []

    def call(self, operation, pid, **arguments):
        self.calls.append(operation)
        if operation == "inspect":
            return {"status": "ready", "windows": [{"index": 0, "title": "企业微信", "nodes": [
                {"role": "AXTextArea", "path": [0, 8, 14, 0, 2, 0], "valueSettable": True, "value": self.draft, "frame": [400, 400, 500, 100]},
                {"role": "AXStaticText", "path": [0, 8, 10], "value": self.header, "frame": [410, 110, 150, 20]},
                {"role": "AXRow", "path": [0, 8, 2, 0, 0], "selected": True, "frame": [100, 200, 250, 64]},
                {"role": "AXStaticText", "path": [0, 8, 2, 0, 0, 0, 1], "value": TITLE, "frame": [160, 212, 180, 20]},
            ]}]}
        if operation == "paste":
            self.draft = arguments["text"]
            self.header = self.header_after_paste
            if self.interrupt == "preparing":
                raise KeyboardInterrupt()
        if operation == "submit":
            if self.interrupt == "submitting":
                raise subprocess.TimeoutExpired("open", 45)
            self.draft = ""
            return {"status": "submitted", "requiresVerification": True}
        return {"status": "ready"}


class NativeSenderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.mirror = self.root / "mirror.db"
        self.db = sqlite3.connect(self.mirror)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE CONVERSATION(RID INTEGER,name TEXT,conversationtype INTEGER);
            CREATE TABLE MESSAGE(LID INTEGER PRIMARY KEY,RID INTEGER,seq INTEGER,conv_id INTEGER,sender_id INTEGER,
                                 send_time INTEGER,flag INTEGER,content_type INTEGER,content BLOB);
        """)
        self.db.execute("INSERT INTO CONVERSATION VALUES (12,?,0)", (TITLE,))
        self.now = int(time.time())
        self.add_message(101, text="教教我", sender=12)
        self.request = {"deliveryId": "authorized-test", "accountId": "99", "pid": 42770,
                        "target": {"conversationId": "12", "name": TITLE, "conversationType": "direct", "peerUserId": "zhengyin.cai"},
                        "origin": {"lid": "101", "senderId": "12", "sendTime": str(self.now), "text": "教教我"},
                        "text": "本地接口发送测试", "mirror": str(self.mirror), "stateDir": str(self.root / "ledger"),
                        "clientDatabase": "/Profiles/current/Messages1/Info.db"}
        client = mock.patch("native_sender.verify_client_database")
        client.start()
        self.addCleanup(client.stop)

    def add_message(self, lid, text="本地接口发送测试", sender=99, conversation=12, rid=202, seq=11, flag=0, sent=None):
        self.db.execute("INSERT INTO MESSAGE VALUES (?,?,?,?,?,?,?,?,?)",
                        (lid, rid, seq, conversation, sender, self.now if sent is None else sent, flag, 0, body(text)))
        self.db.commit()

    def test_static_direct_header_and_unique_native_receipt(self):
        bridge = FakeBridge()
        self.assertEqual(process(self.request, bridge=bridge)["status"], "unknown")
        self.assertEqual(bridge.calls.count("submit"), 1)
        self.add_message(102)
        result = process(self.request, "verify", bridge=bridge)
        self.assertEqual(result["status"], "sent")
        self.assertEqual(result["receipt"]["rid"], "202")
        calls = list(bridge.calls)
        self.assertEqual(process(self.request, bridge=bridge), result)
        self.assertEqual(bridge.calls, calls)
        self.assertEqual((self.root / "ledger").stat().st_mode & 0o777, 0o700)
        for path in (self.root / "ledger").glob("*.json"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_wrong_mirror_identity_cannot_touch_ui(self):
        self.db.execute("UPDATE CONVERSATION SET name='someone else'")
        self.db.commit()
        bridge = FakeBridge()
        with self.assertRaises(Blocked):
            process(self.request, bridge=bridge)
        self.assertEqual(bridge.calls, [])

    def test_same_name_native_conversations_block_ui_selection(self):
        self.db.execute("INSERT INTO CONVERSATION VALUES (24,?,0)", (TITLE,))
        self.db.commit()
        bridge = FakeBridge()
        with self.assertRaises(Blocked):
            process(self.request, bridge=bridge)
        self.assertEqual(bridge.calls, [])

    def test_original_sender_and_exact_body_are_verified(self):
        self.request["origin"]["senderId"] = "98"
        with self.assertRaises(Blocked):
            process(self.request, bridge=FakeBridge())

    def test_existing_draft_is_preserved_before_switching(self):
        bridge = FakeBridge(draft="用户自己的草稿")
        with self.assertRaises(Blocked):
            process(self.request, bridge=bridge)
        self.assertEqual(bridge.calls, ["inspect"])
        self.assertEqual(bridge.draft, "用户自己的草稿")

    def test_changed_header_after_pasting_never_submits(self):
        bridge = FakeBridge(header_after_paste="another conversation")
        result = process(self.request, bridge=bridge)
        self.assertEqual(result["status"], "blocked")
        self.assertNotIn("submit", bridge.calls)

    def test_interrupted_submission_never_retries(self):
        bridge = FakeBridge(interrupt="submitting")
        self.assertEqual(process(self.request, bridge=bridge)["status"], "unknown")
        calls = list(bridge.calls)
        self.assertEqual(process(self.request, bridge=bridge)["status"], "unknown")
        self.assertEqual(bridge.calls, calls)
        self.assertEqual(bridge.calls.count("submit"), 1)
        self.add_message(102)
        self.assertEqual(process(self.request, "verify", bridge=bridge)["status"], "sent")

    def test_interrupted_preparation_preserves_draft_and_does_not_repeat_paste(self):
        bridge = FakeBridge(interrupt="preparing")
        with self.assertRaises(KeyboardInterrupt):
            process(self.request, bridge=bridge)
        calls = list(bridge.calls)
        self.assertEqual(process(self.request, bridge=bridge)["status"], "blocked")
        self.assertEqual(bridge.calls, calls)
        self.assertEqual(bridge.draft, self.request["text"])

    def test_same_delivery_id_cannot_change_body(self):
        bridge = FakeBridge()
        process(self.request, bridge=bridge)
        changed = {**self.request, "text": "changed"}
        with self.assertRaises(Blocked):
            process(changed, bridge=bridge)
        self.assertEqual(bridge.calls.count("submit"), 1)

    def test_other_senders_conversations_old_text_and_unacknowledged_rows_are_not_receipts(self):
        process(self.request, bridge=FakeBridge())
        cases = [{"sender": 98}, {"conversation": 24}, {"text": "其他正文"}, {"sent": self.now - 60}, {"rid": 0}, {"flag": 1}]
        for index, values in enumerate(cases):
            with self.subTest(values=values):
                self.db.execute("DELETE FROM MESSAGE WHERE LID>101")
                self.add_message(102 + index, **values)
                self.assertEqual(process(self.request, "verify", bridge=FakeBridge())["status"], "unknown")

    def test_ambiguous_exact_outgoing_rows_remain_unknown(self):
        process(self.request, bridge=FakeBridge())
        self.add_message(102)
        self.add_message(103, rid=203, seq=12)
        self.assertEqual(process(self.request, "verify", bridge=FakeBridge())["status"], "unknown")

    def test_transport_timeout_keeps_private_request_for_the_running_helper(self):
        app = self.root / "helper.app"
        app.mkdir()
        pending = self.root / "pending"
        pending.mkdir(mode=0o700)
        with mock.patch("native_sender.tempfile.mkdtemp", return_value=str(pending)), \
                mock.patch("native_sender.subprocess.run", side_effect=subprocess.TimeoutExpired("open", 45)):
            with self.assertRaises(subprocess.TimeoutExpired):
                NativeBridge(app).call("submit", 42770)
        self.assertEqual(json.loads((pending / "request.json").read_text())["op"], "submit")
        self.assertEqual((pending / "request.json").stat().st_mode & 0o777, 0o600)

    def resolver_config(self):
        settings = {"database": "/Profiles/current/Messages1/Info.db", "accountId": "99"}
        data = self.root / ".agent-data"
        data.mkdir()
        db = sqlite3.connect(data / "agent.db")
        db.execute("CREATE TABLE messaging_state(key TEXT,payload TEXT)")
        db.execute("INSERT INTO messaging_state VALUES ('settings',?)", (json.dumps({"source": settings}),))
        db.commit()
        db.close()
        identity = hashlib.sha256(json.dumps(settings, separators=(",", ":")).encode()).hexdigest()[:24]
        mirror = data / "messaging-wecom" / identity / "mirror.db"
        mirror.parent.mkdir(parents=True)
        os.link(self.mirror, mirror)

    def test_simple_local_call_resolves_an_exact_alias_from_the_existing_receiver(self):
        self.resolver_config()
        result = resolve_request({"baseDir": str(self.root), "recipient": "zhengyin.cai", "deliveryId": "one", "text": "你好"})
        self.assertEqual(result["target"], self.request["target"])
        self.assertEqual(result["accountId"], "99")
        self.assertEqual(result["deliveryId"], "one")
        self.assertEqual(result["text"], "你好")

    def test_simple_call_blocks_ambiguous_names(self):
        self.resolver_config()
        self.db.execute("INSERT INTO CONVERSATION VALUES (24,'蔡正银(other.cai)',0)")
        self.db.commit()
        with self.assertRaises(Blocked):
            resolve_request({"baseDir": str(self.root), "recipient": "蔡正银", "deliveryId": "one", "text": "你好"})

    def test_simple_call_uses_host_working_directory_after_package_relocation(self):
        self.resolver_config()
        with mock.patch.dict(os.environ, {"AGENT_DATA_DIR": ""}), mock.patch("native_sender.Path.cwd", return_value=self.root):
            result = resolve_request({"recipient": "zhengyin.cai", "deliveryId": "one", "text": "你好"})
        self.assertEqual(result["target"], self.request["target"])


class ClientAccountTests(unittest.TestCase):
    def test_current_client_must_hold_the_configured_single_profile(self):
        path = "/Users/test/Profiles/own/Messages1/Info.db"
        with mock.patch("native_sender.subprocess.run", return_value=mock.Mock(stdout="p1\nn" + path + "\n")):
            verify_client_database(1, path)
            with self.assertRaises(Blocked):
                verify_client_database(1, path.replace("own", "other"))
        with mock.patch("native_sender.subprocess.run", return_value=mock.Mock(stdout="n" + path + "\nn" + path.replace("own", "other") + "\n")):
            with self.assertRaises(Blocked):
                verify_client_database(1, path)


if __name__ == "__main__":
    unittest.main()
