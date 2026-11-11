import json
import hashlib
import os
from pathlib import Path
import socket
import sqlite3
import stat
import subprocess
import tempfile
import threading
import contextlib
import time
import unittest
from unittest import mock

from native_sender import (APP_BUILD, APP_VERSION, SOURCE_SHA256, Blocked, InjectBridge, NativeBridge,
                           process, probe_inject_socket, resolve_request, validate_bridge_response,
                           verify_client_database)


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


BRIDGE_SOURCE_SHA256 = "a" * 64
LARGE_ACCOUNT = "1688850098765432190"
LARGE_CONVERSATION = "900719925474099"
LARGE_TEXT = "精确的本地身份 " + "9" * 500 + " ✅"


def bridge_response(command, pid=42770, instance="instance-clone-001", **changes):
    response = {"ok": True, "protocol": 2, "instanceId": instance, "pid": pid,
                "appVersion": APP_VERSION, "appBuild": APP_BUILD, "sourceSha256": SOURCE_SHA256,
                "bridgeSourceSha256": BRIDGE_SOURCE_SHA256, "sendingEnabled": command != "status",
                "state": "submitted" if command == "send" else "ready", "detail": "ok"}
    if command == "status":
        response["sendingEnabled"] = False
    if command in ("preflight", "send"):
        response.update(accountId=LARGE_ACCOUNT, conversationId=LARGE_CONVERSATION)
    response.update(changes)
    return response


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

    def configure_inject(self, account=LARGE_ACCOUNT, conversation=LARGE_CONVERSATION):
        self.request["accountId"] = account
        self.request["target"]["conversationId"] = conversation
        self.request["origin"]["senderId"] = "12"
        self.request["text"] = LARGE_TEXT
        self.db.execute("UPDATE CONVERSATION SET RID=? WHERE RID=12", (int(conversation),))
        self.db.execute("UPDATE MESSAGE SET conv_id=? WHERE LID=101", (int(conversation),))
        self.db.commit()

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


class ProtocolV2Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.socket_path = str(self.root / "bridge.sock")
        self.identity = {"accountId": LARGE_ACCOUNT, "conversationId": LARGE_CONVERSATION,
                         "deliveryId": "strict-v2-one", "text": LARGE_TEXT,
                         "clientDatabase": "/Profiles/own/Messages1/Info.db"}
        self.database = mock.patch("native_sender.verify_client_database")
        self.database.start()
        self.addCleanup(self.database.stop)

    def request(self):
        return {"deliveryId": "strict-v2-one", "accountId": LARGE_ACCOUNT, "pid": 42770,
                "target": {"conversationId": LARGE_CONVERSATION, "name": TITLE, "conversationType": "direct", "peerUserId": "zhengyin.cai"},
                "origin": {"lid": "101", "senderId": "12", "sendTime": str(int(time.time())), "text": "教教我"},
                "text": LARGE_TEXT, "mirror": str(self.root / "mirror.db"), "stateDir": str(self.root / "ledger"),
                "clientDatabase": "/Profiles/own/Messages1/Info.db"}

    def response_map(self, **changes):
        return {command: bridge_response(command, **changes) for command in ("status", "preflight", "send")}

    def fake_socket(self, responses):
        calls = []

        def create_response(payload):
            command = payload["cmd"]
            value = responses.get(command)
            if isinstance(value, Exception):
                raise value
            if callable(value):
                return value(payload)
            result = dict(value)
            if command in ("preflight", "send") and result.get("ok"):
                validate_bridge_response(result, command, 42770, expected_instance=self.status_identity, identity=payload)
            elif command == "status":
                self.status_identity = result["instanceId"]
                validate_bridge_response(result, command, 42770, identity=payload)
            else:
                validate_bridge_response(result, command, 42770, identity=payload)
            return result

        def request(payload):
            calls.append(dict(payload))
            return create_response(payload)

        bridge = InjectBridge(self.socket_path)
        request_mock = mock.Mock(side_effect=request)
        bridge._request = request_mock
        bridge.request = request_mock
        return bridge, calls

    @contextlib.contextmanager
    def socket_server(self, body):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(server.close)
        server.bind(self.socket_path)
        os.chmod(self.socket_path, 0o600)
        server.listen(1)
        thread = threading.Thread(target=lambda: self.accept_once(server, body))
        thread.start()
        self.addCleanup(lambda: thread.join(2))
        try:
            yield
        finally:
            pass

    @staticmethod
    def accept_once(server, body):
        client, _ = server.accept()
        with client:
            client.recv(8192)
            client.sendall(body)

    def ledger(self, request):
        return Path(request["stateDir"]) / (hashlib.sha256(request["deliveryId"].encode()).hexdigest() + ".json")

    def prepare_mirror(self, request):
        path = Path(request["mirror"])
        connection = sqlite3.connect(path)
        if connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='CONVERSATION'").fetchone():
            connection.close()
            return
        connection.executescript("""
            CREATE TABLE CONVERSATION(RID INTEGER,name TEXT,conversationtype INTEGER);
            CREATE TABLE MESSAGE(LID INTEGER PRIMARY KEY,RID INTEGER,seq INTEGER,conv_id INTEGER,sender_id INTEGER,
                                 send_time INTEGER,flag INTEGER,content_type INTEGER,content BLOB);
        """)
        connection.execute("INSERT INTO CONVERSATION VALUES (?,?,0)", (int(request["target"]["conversationId"]), TITLE))
        connection.execute("INSERT INTO MESSAGE VALUES (101,1,1,?,12,?,0,0,?)",
                           (int(request["target"]["conversationId"]), int(request["origin"]["sendTime"]), body("教教我")))
        connection.commit()
        connection.close()

    def receipt_mirror(self, request, text):
        path = Path(request["mirror"])
        connection = sqlite3.connect(path)
        connection.execute("INSERT INTO MESSAGE VALUES (102,202,11,?,?,?,0,0,?)",
                           (int(request["target"]["conversationId"]), int(request["accountId"]), int(time.time()), body(text)))
        connection.commit()
        connection.close()

    def test_exact_large_identities_preflight_then_single_pinned_send(self):
        request = self.request()
        self.prepare_mirror(request)
        responses = self.response_map()
        bridge, calls = self.fake_socket(responses)
        result = process(request, bridge=bridge)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual([call["cmd"] for call in calls], ["status", "preflight", "send"])
        expected = {"pid": 42770, "instanceId": "instance-clone-001", "accountId": LARGE_ACCOUNT,
                    "conversationId": LARGE_CONVERSATION, "deliveryId": "strict-v2-one", "text": LARGE_TEXT,
                    "clientDatabase": "/Profiles/own/Messages1/Info.db"}
        for command in ("preflight", "send"):
            payload = next(call for call in calls if call["cmd"] == command)
            self.assertEqual({key: payload[key] for key in expected}, expected)
            self.assertNotIn("conv_name", payload)
            self.assertNotIn("strict", payload)
        ledger = json.loads(self.ledger(request).read_text())
        self.assertEqual(ledger["transport"], "local-injection")
        self.assertTrue(ledger["submittedAt"])
        calls_before = list(calls)
        with mock.patch("native_sender.probe_inject_socket", side_effect=AssertionError("ledger-only path probed")), \
                mock.patch("native_sender.InjectBridge", side_effect=AssertionError("ledger-only path constructed sender")), \
                mock.patch.dict(os.environ, {"AGENT_WECOM_SENDER": "inject"}):
            self.assertEqual(process(request)["status"], "unknown")
            self.assertEqual(process(request, "verify")["status"], "unknown")
        bridge.request.reset_mock()
        self.receipt_mirror(request, LARGE_TEXT)
        sent = process(request, "verify", bridge=bridge)
        self.assertEqual(sent["status"], "sent")
        self.assertEqual(sent["receipt"]["transport"], "local-injection")
        bridge.request.assert_not_called()
        self.assertEqual(calls, calls_before)
        self.assertEqual(bridge.call("verify")["status"], "ready")

    def test_preflight_failure_never_submits_or_records_intent(self):
        request = self.request()
        self.prepare_mirror(request)
        blocked = bridge_response("preflight", ok=False, state="blocked", detail="草稿未清空")
        del blocked["accountId"], blocked["conversationId"]
        responses = self.response_map()
        responses["preflight"] = blocked
        bridge, calls = self.fake_socket(responses)
        self.assertEqual(process(request, bridge=bridge)["status"], "blocked")
        self.assertEqual([call["cmd"] for call in calls], ["status", "preflight"])
        ledger = json.loads(self.ledger(request).read_text())
        self.assertNotIn("submittedAt", ledger)
        self.assertEqual(ledger["status"], "blocked")

    def test_disabled_invalid_instance_and_legacy_bridge_fail_closed(self):
        request = self.request()
        self.prepare_mirror(request)
        disabled = self.response_map()
        disabled["preflight"]["sendingEnabled"] = False
        bridge, calls = self.fake_socket(disabled)
        self.assertEqual(process(request, bridge=bridge)["status"], "blocked")
        self.assertNotIn("send", [call["cmd"] for call in calls])
        changed = self.response_map()
        changed["preflight"]["instanceId"] = "restarted-instance"
        bridge, calls = self.fake_socket(changed)
        request["deliveryId"] = "strict-v2-two"
        self.assertEqual(process(request, bridge=bridge)["status"], "blocked")
        self.assertNotIn("send", [call["cmd"] for call in calls])
        legacy = mock.Mock()
        legacy.protocol = 1
        with self.assertRaises(Blocked):
            process(request, bridge=legacy)

    def test_send_blocked_timeout_and_unknown_keep_exact_ledger_semantics(self):
        cases = [
            (bridge_response("send", ok=False, state="blocked", detail="草稿改变"), "blocked"),
            (Blocked("socket timeout"), "unknown"),
            (bridge_response("send", ok=False, state="unknown", detail="提交状态未确认"), "unknown"),
        ]
        for index, (value, expected) in enumerate(cases):
            with self.subTest(index=index):
                request = self.request()
                request["deliveryId"] = f"strict-v2-case-{index}"
                self.prepare_mirror(request)
                responses = self.response_map()
                if isinstance(value, Blocked):
                    responses["send"] = value
                else:
                    del value["accountId"], value["conversationId"]
                    responses["send"] = value
                bridge, calls = self.fake_socket(responses)
                self.assertEqual(process(request, bridge=bridge)["status"], expected)
                self.assertEqual([call["cmd"] for call in calls], ["status", "preflight", "send"])
                ledger = json.loads(self.ledger(request).read_text())
                self.assertEqual("submittedAt" in ledger, expected == "unknown")
                calls_before = list(calls)
                self.assertEqual(process(request, "verify", bridge=bridge)["status"], expected)
                self.assertEqual(calls, calls_before)

    def test_auto_probe_selects_strict_bridge_but_only_refusal_retains_gui(self):
        request = self.request()
        self.prepare_mirror(request)
        pinned = {"pid": 42770, "instanceId": "instance-clone-001", "accountId": LARGE_ACCOUNT,
                  "conversationId": LARGE_CONVERSATION}
        with mock.patch("native_sender.probe_inject_socket", return_value=True) as probe, \
                mock.patch("native_sender.NativeBridge") as gui_class, \
                mock.patch.object(InjectBridge, "call", side_effect=lambda operation, **arguments: (
                    pinned if operation == "preflight" else {"status": "unknown", "submitted": True})) as call, \
                mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(process(request)["status"], "unknown")
            probe.assert_called_once()
            gui_class.assert_not_called()
            self.assertEqual([args.args[0] for args in call.call_args_list], ["preflight", "send"])
        request["deliveryId"] = "auto-refused"
        with mock.patch("native_sender.probe_inject_socket", return_value=False) as probe, \
                mock.patch("native_sender.NativeBridge", return_value=FakeBridge()) as gui_class, \
                mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(process(request)["status"], "unknown")
            probe.assert_called_once()
            gui_class.assert_called_once()
        request["deliveryId"] = "forced-invalid"
        with mock.patch("native_sender.probe_inject_socket") as probe, \
                mock.patch("native_sender.NativeBridge") as gui_class, \
                mock.patch.object(InjectBridge, "call", side_effect=Blocked("invalid peer or protocol")), \
                mock.patch.dict(os.environ, {"AGENT_WECOM_SENDER": "inject"}):
            self.assertEqual(process(request)["status"], "blocked")
            probe.assert_not_called()
            gui_class.assert_not_called()
        request["deliveryId"] = "auto-untrusted"
        with mock.patch("native_sender.probe_inject_socket", return_value=True), \
                mock.patch("native_sender.NativeBridge") as gui_class, \
                mock.patch.object(InjectBridge, "call", side_effect=Blocked("invalid peer or protocol")), \
                mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(process(request)["status"], "blocked")
            gui_class.assert_not_called()
        request["deliveryId"] = "probe-denied"
        with mock.patch("native_sender.probe_inject_socket", side_effect=Blocked("permission denied")), \
                mock.patch("native_sender.NativeBridge") as gui_class, \
                mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(Blocked):
                process(request)
            gui_class.assert_not_called()

    def test_protocol_identity_hash_and_pid_guards(self):
        valid = self.response_map()
        for command, changes in (("status", {"protocol": 1}), ("status", {"instanceId": ""}),
                                 ("status", {"sourceSha256": "0" * 64}), ("status", {"bridgeSourceSha256": "xyz"}),
                                 ("status", {"appVersion": "5.0.12"}), ("status", {"appBuild": "95048"}),
                                 ("status", {"pid": 42771}), ("status", {"ok": "true"}),
                                 ("status", {"state": "unknown"}), ("preflight", {"accountId": "other"})):
            with self.subTest(command=command, changes=changes):
                changed = self.response_map()
                changed[command].update(changes)
                with self.assertRaises(Blocked):
                    validate_bridge_response(changed[command], command, 42770, identity=self.identity)
        self.assertEqual(validate_bridge_response(valid["status"], "status", 42770)["instanceId"], "instance-clone-001")
        with self.assertRaises(Blocked):
            validate_bridge_response(valid["preflight"], "preflight", 42770, expected_instance="other", identity=self.identity)
        with self.assertRaises(Blocked):
            validate_bridge_response(valid["preflight"], "preflight", 42770, expected_bridge_source="b" * 64, identity=self.identity)
        blocked = bridge_response("send", ok=False, state="blocked", detail="已有草稿")
        del blocked["accountId"], blocked["conversationId"]
        self.assertEqual(validate_bridge_response(blocked, "send", 42770, identity=self.identity)["state"], "blocked")
        unknown = bridge_response("send", ok=False, state="unknown", detail="无法确认")
        del unknown["accountId"], unknown["conversationId"]
        self.assertEqual(validate_bridge_response(unknown, "send", 42770, identity=self.identity)["state"], "unknown")

    def test_socket_framing_size_and_cleanup(self):
        path = self.root / "bridge.sock"
        payload = b"x" * 65_537
        with self.socket_server(payload + b"\n" + b'{"too":"late"}\n'):
            with mock.patch("native_sender.socket_peer_identity", return_value=(os.getuid(), 42770)):
                with self.assertRaises(Blocked):
                    InjectBridge(self.socket_path)._request({"cmd": "status"})
        valid_path = self.root / "valid.sock"
        self.socket_path = str(valid_path)
        with self.socket_server((json.dumps(bridge_response("status", pid=42770)) + "\nextra\n").encode()):
            with mock.patch("native_sender.socket_peer_identity", return_value=(os.getuid(), 42770)):
                self.assertEqual(InjectBridge(str(valid_path))._request({"cmd": "status"})["ok"], True)
        truncated_path = self.root / "truncated.sock"
        self.socket_path = str(truncated_path)
        with self.socket_server(json.dumps(bridge_response("status")).encode()):
            with mock.patch("native_sender.socket_peer_identity", return_value=(os.getuid(), 42770)):
                with self.assertRaises(Blocked):
                    InjectBridge(str(truncated_path))._request({"cmd": "status"})
        os.chmod(valid_path, 0o644)
        with self.assertRaises(Blocked):
            InjectBridge(str(valid_path))._request({"cmd": "status"})
        link = self.root / "linked.sock"
        link.symlink_to(valid_path)
        with self.assertRaises(Blocked):
            InjectBridge(str(link))._request({"cmd": "status"})


if __name__ == "__main__":
    unittest.main()
