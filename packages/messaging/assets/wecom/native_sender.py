#!/usr/bin/env python3
"""Submit through the local WeCom client; verify using the receiver's existing mirror."""
import contextlib
import ctypes
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

from reader import decode_body

DEFAULT_APP = Path.home() / "Library/Application Support/AgentRoam/wecom-sender/WeComSendBridge.app"
CLIENT = "/Applications/企业微信.app/Contents/MacOS/企业微信"


class Blocked(Exception):
    pass


class NativeBridge:
    def __init__(self, app=DEFAULT_APP):
        self.app = Path(app)

    def call(self, operation, pid, **arguments):
        if not self.app.is_dir():
            raise Blocked("本地企微发送桥未安装，请先安装并授予辅助功能权限")
        root = Path(tempfile.mkdtemp(prefix="agentroam-wecom-"))
        request, response = root / "request.json", root / "response.json"
        private_json(request, {"op": operation, "pid": pid, **arguments})
        completed = False
        try:
            subprocess.run(["/usr/bin/open", "-n", "-W", str(self.app), "--args", "--request", str(request),
                            "--response", str(response)], check=True, capture_output=True, timeout=45)
            if not response.is_file():
                raise RuntimeError("发送桥退出但没有返回结果")
            result = json.loads(response.read_text())
            completed = True
            return result
        finally:
            # LaunchServices' child may outlive a timed-out `open`. Keep its request/response private and valid.
            if completed:
                shutil.rmtree(root)


# ---------------------------------------------------------------------------
# 进程内发送后端：通过 Unix socket 连到实验副本里的 NativeInjectBridge.dylib。
# dylib 直接调用 WEWInputViewController 的内部方法，不走 AX，但仍依赖当前聊天控制器。
# 保留与 NativeBridge 相同的 call() 接口，process() 无需区分后端。
# ---------------------------------------------------------------------------
INJECT_SOCKET = (os.environ.get("AGENT_WECOM_INJECT_SOCKET")
                 or str(Path.home() / "Library/Containers/com.tencent.WeWorkMac/Data/tmp/wework-inject.sock"))
PROTOCOL = 2
APP_VERSION = "5.0.13"
APP_BUILD = "95049"
SOURCE_SHA256 = "079eabdc95281c62b4daf7f431124dff53caf5d11ccbe1f8715b2b2f56a4daf2"
MAX_BRIDGE_RESPONSE = 65_536
RESPONSE_FIELDS = ("ok", "protocol", "instanceId", "pid", "appVersion", "appBuild", "sourceSha256",
                   "bridgeSourceSha256", "sendingEnabled", "state", "detail")


def socket_peer_identity(client):
    """Return the owning UID and PID of a connected AF_UNIX socket on macOS."""
    if sys.platform != "darwin":
        raise Blocked("注入发送桥仅支持 macOS 的本地进程身份校验")
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.getpeereid.argtypes = (ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint))
        libc.getpeereid.restype = ctypes.c_int
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        if libc.getpeereid(client.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            raise OSError(ctypes.get_errno(), "getpeereid 失败")
        # LOCAL_PEERPID is SOL_LOCAL (0) / 2 on Darwin and returns a 32-bit PID.
        credentials = client.getsockopt(0, 2, ctypes.sizeof(ctypes.c_uint))
        peer_pid = ctypes.c_uint.from_buffer_copy(credentials).value
        if uid.value != os.getuid() or not isinstance(peer_pid, int) or peer_pid <= 0:
            raise Blocked("注入发送桥的本地进程身份不可信")
        return uid.value, peer_pid
    except (AttributeError, OSError, ValueError) as error:
        raise Blocked("无法校验注入发送桥的本地进程身份：" + str(error))


def validate_bridge_response(response, expected_operation=None, expected_pid=None,
                             expected_instance=None, identity=None, expected_bridge_source=None):
    """Validate protocol v2 responses and the socket peer's process identity."""
    if not isinstance(response, dict) or any(field not in response for field in RESPONSE_FIELDS):
        raise Blocked("注入发送桥返回了不完整的协议 v2 响应")
    if response["protocol"] != PROTOCOL or type(response["protocol"]) is not int \
            or type(response["ok"]) is not bool or type(response["pid"]) is not int or response["pid"] <= 0 \
            or not isinstance(response["instanceId"], str) or not response["instanceId"] \
            or response["appVersion"] != APP_VERSION or response["appBuild"] != APP_BUILD \
            or response["sourceSha256"] != SOURCE_SHA256 \
            or not isinstance(response["bridgeSourceSha256"], str) \
            or not re.fullmatch(r"[0-9a-f]{64}", response["bridgeSourceSha256"]) \
            or type(response["sendingEnabled"]) is not bool \
            or response["state"] not in ("ready", "blocked", "submitted", "unknown") \
            or not isinstance(response["detail"], str):
        raise Blocked("注入发送桥协议、版本或来源校验失败")
    if expected_pid is not None and response["pid"] != expected_pid:
        raise Blocked("注入发送桥响应中的进程身份不匹配")
    if expected_instance is not None and response["instanceId"] != expected_instance:
        raise Blocked("注入发送桥实例在预检和发送之间发生变化")
    if expected_bridge_source is not None and response["bridgeSourceSha256"] != expected_bridge_source:
        raise Blocked("注入发送桥构建来源在请求之间发生变化")
    if expected_operation == "status" and response["ok"] and response["state"] != "ready":
        raise Blocked("注入发送桥未就绪")
    if expected_operation == "preflight" and response["ok"] and response["state"] != "ready":
        raise Blocked("注入发送桥预检未返回就绪状态")
    if expected_operation == "send" and response["ok"] and response["state"] != "submitted":
        raise Blocked("注入发送桥未返回已提交状态")
    if expected_operation in ("preflight", "send") and not response["sendingEnabled"]:
        raise Blocked("注入发送桥未启用发送")
    if identity is not None and response["ok"] and expected_operation in ("preflight", "send"):
        for field in ("accountId", "conversationId"):
            if response.get(field) != identity[field]:
                raise Blocked("注入发送桥回显的账号或会话身份不匹配")
    return response


def delivery_identity(request):
    return {"accountId": str(request["accountId"]),
            "conversationId": str(request["target"]["conversationId"])}


class InjectBridge:
    """严格协议 v2 客户端；只连接当前用户、权限 0600、可校验 peer UID/PID 的本地 socket。"""

    def __init__(self, socket_path=INJECT_SOCKET, timeout=25.0):
        self.socket_path = socket_path
        self.timeout = timeout
        self._peer_pid = None
        self._instance_id = None
        self._bridge_source = None

    def _request(self, payload):
        path = self.socket_path
        try:
            info = os.lstat(path)
            if not stat.S_ISSOCK(info.st_mode) or stat.S_ISLNK(info.st_mode) \
                    or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise Blocked("注入发送桥 socket 必须属于当前用户且权限为 0600")
        except OSError as error:
            raise Blocked("注入发送桥 socket 不可用：" + str(error))
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(self.timeout)
                client.connect(path)
                _, peer_pid = socket_peer_identity(client)
                if self._peer_pid is not None and self._peer_pid != peer_pid:
                    raise Blocked("注入发送桥进程身份在请求之间发生变化")
                client.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
                buf = b""
                while b"\n" not in buf:
                    chunk = client.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                    if len(buf.split(b"\n", 1)[0]) > MAX_BRIDGE_RESPONSE:
                        raise Blocked("注入发送桥响应超过长度上限")
                line = buf.split(b"\n", 1)[0]
                if b"\n" not in buf or not line or len(line) > MAX_BRIDGE_RESPONSE:
                    raise Blocked("注入发送桥未返回有效的一行 JSON 响应")
                try:
                    response = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise Blocked("注入发送桥返回了无效 JSON：" + str(error))
                validate_bridge_response(response, expected_operation=payload.get("cmd"),
                                         expected_pid=peer_pid, identity=payload,
                                         expected_instance=self._instance_id,
                                         expected_bridge_source=self._bridge_source)
                self._peer_pid = peer_pid
                self._instance_id = response["instanceId"]
                self._bridge_source = response["bridgeSourceSha256"]
                return response
        except (OSError, socket.timeout) as error:
            raise Blocked("注入发送桥通信失败：" + str(error))
        except (Blocked, ValueError):
            raise

    def preflight(self, request):
        """先 status 再 preflight：两次响应的 PID/instance/来源都被严格校验。"""
        status = self._request({"cmd": "status"})
        if not status["ok"]:
            raise Blocked("注入发送桥未就绪：" + status["detail"])
        identity = delivery_identity(request)
        payload = {"cmd": "preflight", "pid": status["pid"], "instanceId": status["instanceId"],
                   "deliveryId": request["deliveryId"], "text": request["text"],
                   "clientDatabase": request["clientDatabase"], **identity}
        result = self._request(payload)
        if not result["ok"]:
            raise Blocked("注入发送预检未通过：" + result["detail"])
        verify_client_database(result["pid"], request["clientDatabase"])
        return {"pid": result["pid"], "instanceId": result["instanceId"], **identity}

    def call(self, operation, pid=None, **arguments):
        if operation == "preflight":
            if "request" not in arguments:
                raise Blocked("不支持旧版按名称发送的企微注入桥，请使用协议 v2")
            return self.preflight(arguments["request"])
        if operation == "send":
            if "request" not in arguments or "pinned" not in arguments:
                raise Blocked("不支持旧版按名称发送的企微注入桥，请使用协议 v2")
            request = arguments["request"]
            pinned = arguments["pinned"]
            payload = {"cmd": "send", "pid": pinned["pid"], "instanceId": pinned["instanceId"],
                       "deliveryId": request["deliveryId"], "text": request["text"],
                       "clientDatabase": request["clientDatabase"],
                       "accountId": pinned["accountId"], "conversationId": pinned["conversationId"]}
            result = self._request(payload)
            if not result["ok"]:
                # A definite bridge rejection before submission is retryable; an unknown result keeps the intent.
                if result["state"] == "blocked":
                    return {"status": "blocked", "error": result["detail"] or "注入发送被明确拒绝"}
                return {"status": "unknown", "submitted": True,
                        "error": result["detail"] or "注入发送结果未确认，请核对原会话；不会自动重发"}
            # submitted 仅表示企微已接受提交；交付回执由接收侧本人发送记录确认。
            return {"status": "unknown", "submitted": True}
        if operation == "verify":
            # 回执只从本地镜库读取；绝不因为验证而再次调用 socket。
            return {"status": "ready"}
        # 非 GUI 路径无需 inspect / selectConversation / paste / submit。
        return {"status": "ready"}


def probe_inject_socket(socket_path=INJECT_SOCKET):
    """An available endpoint selects strict validation; only absent/refused sockets retain AX."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(1.0)
            probe.connect(socket_path)
        return True
    except (FileNotFoundError, ConnectionRefusedError):
        return False
    except OSError as error:
        raise Blocked("注入发送桥探测失败，未回退辅助功能发送：" + str(error))


def private_json(path, value):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def accepted(result):
    if result.get("status") != "ready":
        raise Blocked(str(result.get("error") or result.get("code") or "企微发送桥未就绪"))
    return result


def client_pid(bridge):
    output = subprocess.run(["/bin/ps", "-axo", "pid=,comm="], check=True, capture_output=True, text=True).stdout
    candidates = [int(line.strip().split(None, 1)[0]) for line in output.splitlines()
                  if len(line.strip().split(None, 1)) == 2 and line.strip().split(None, 1)[1] == CLIENT]
    owners = []
    for pid in candidates:
        state = accepted(bridge.call("inspect", pid, compact=True))
        if any(window["title"] == "企业微信" for window in state.get("windows", [])):
            owners.append(pid)
    if len(owners) != 1:
        raise Blocked("未唯一匹配原版企微主窗口，请打开原版企微并保持主窗口可见")
    return owners[0]


def verify_client_database(pid, expected):
    if not isinstance(expected, str) or not expected:
        raise Blocked("缺少已配置的企微账号数据库路径")
    output = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-p", str(pid), "-Fn"],
                            check=True, capture_output=True, text=True, errors="replace", timeout=10).stdout
    # Inspect file names held by this client, without reading the protected source database.
    paths = {line[1:] for line in output.splitlines() if line.startswith("n")
             and re.search(r"/Profiles/[^/]+/Messages[0-9]*/Info\.db$", line[1:])}
    profiles = {str(Path(path).parent.parent) for path in paths}
    if os.path.normpath(expected) not in paths or len(profiles) != 1:
        raise Blocked("原版企微当前账号与接收侧账号未唯一匹配，未发送")


def main_window(state):
    windows = [window for window in accepted(state).get("windows", []) if window["title"] == "企业微信"]
    if len(windows) != 1:
        raise Blocked("未唯一匹配企微主窗口")
    return windows[0]


def editor(window):
    inputs = [node for node in window["nodes"] if node["role"] == "AXTextArea" and node.get("valueSettable")]
    if len(inputs) != 1:
        raise Blocked("未唯一匹配企微聊天输入框")
    return inputs[0]


def chat_controls(window, title):
    target = editor(window)
    headers = [node for node in window["nodes"] if node["role"] in ("AXTextField", "AXStaticText")
               and node["value"] == title and 2 <= len(node["path"]) <= 4
               and node["path"][:-1] == target["path"][:len(node["path"]) - 1]
               and node.get("frame", [0, 0])[0] >= target["frame"][0]
               and node["frame"][1] < target["frame"][1]]
    rows = [node for node in window["nodes"] if node["role"] == "AXRow" and node.get("selected")
            and node.get("frame", [target["frame"][0]])[0] < target["frame"][0]]
    if len(headers) != 1 or len(rows) != 1:
        raise Blocked("聊天标题或选中的会话未唯一匹配，未输入或发送")
    row = rows[0]
    labels = [node["value"] for node in window["nodes"] if node["role"] == "AXStaticText"
              and node["path"][:len(row["path"])] == row["path"]
              and node.get("frame", [0, 1e9])[1] < row["frame"][1] + 30
              and node["frame"][0] > row["frame"][0] + 30 and node["value"]]
    if not labels or labels[0] != title:
        raise Blocked("所选会话与聊天标题不一致，未输入或发送")
    return target, headers[0]


def control_args(window, node):
    return {"window": window["index"], "windowTitle": window["title"], "path": node["path"],
            "role": node["role"], "expectedValue": node["value"]}


@contextlib.contextmanager
def mirror_connection(path):
    path = Path(path)
    if not path.is_file():
        raise Blocked("接收侧镜像尚未就绪，请先完成本地消息采集")
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=3)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA writable_schema=ON")
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        yield connection
    finally:
        connection.close()


def verify_target(request):
    account, target = str(request["accountId"]), request["target"]
    if not account.isdigit() or not str(target["conversationId"]).isdigit():
        raise Blocked("本地账号或会话 ID 无效")
    kind = {"direct": 0, "group": 1}.get(target.get("conversationType"))
    if kind is None:
        raise Blocked("未知会话类型不能用于本地发送")
    with mirror_connection(request["mirror"]) as connection:
        row = connection.execute("SELECT name,conversationtype FROM CONVERSATION WHERE RID=?", (target["conversationId"],)).fetchone()
        if not row or row["name"] != target["name"] or row["conversationtype"] != kind:
            raise Blocked("接收侧会话 ID、名称或类型不匹配")
        if connection.execute("SELECT COUNT(*) FROM CONVERSATION WHERE name=?", (target["name"],)).fetchone()[0] != 1:
            raise Blocked("企微存在同名会话，不能仅凭界面名称发送")
        if kind == 0:
            alias = re.search(r"\(([a-zA-Z0-9_.@-]+)\)$", target["name"])
            if not alias or alias.group(1) != target.get("peerUserId"):
                raise Blocked("私聊联系人别名与接收侧身份不一致")
        origin = request.get("origin")
        if origin:
            row = connection.execute("SELECT conv_id,sender_id,send_time,content,content_type FROM MESSAGE WHERE LID=?", (origin["lid"],)).fetchone()
            if not row or str(row["conv_id"]) != str(target["conversationId"]) or str(row["sender_id"]) != origin["senderId"] \
                    or str(row["send_time"]) != origin["sendTime"] or decode_body(row["content"] or b"", row["content_type"])["text"] != origin["text"]:
                raise Blocked("接收侧未匹配原消息的会话、发送人、时间和正文")
        return str(connection.execute("SELECT COALESCE(MAX(LID),0) FROM MESSAGE WHERE conv_id=?", (target["conversationId"],)).fetchone()[0])


def receipt(request, ledger):
    if not ledger.get("submittedAt"):
        return None
    with mirror_connection(request["mirror"]) as connection:
        rows = connection.execute(
            "SELECT LID,RID,seq,sender_id,send_time,flag,content_type,content FROM MESSAGE "
            "WHERE conv_id=? AND sender_id=? AND LID>? AND send_time>=? ORDER BY LID LIMIT 100",
            (request["target"]["conversationId"], request["accountId"], ledger["baselineLid"], int(ledger["submittedAt"]) - 2)).fetchall()
        matches = []
        for row in rows:
            try:
                body = decode_body(row["content"] or b"", row["content_type"])["text"]
            except (ValueError, UnicodeDecodeError):
                continue
            if body == request["text"]:
                matches.append(row)
        if len(matches) != 1 or int(matches[0]["RID"] or 0) <= 0 or int(matches[0]["seq"] or 0) <= 0 or matches[0]["flag"] != 0:
            return None
        row = matches[0]
        return {"transport": ledger.get("transport", "local-accessibility"), "evidence": "native-outgoing-record", "conversationId": request["target"]["conversationId"],
                "senderId": str(row["sender_id"]), "lid": str(row["LID"]), "rid": str(row["RID"]), "seq": str(row["seq"]),
                "sendTime": str(row["send_time"]), "flag": row["flag"]}


def resolve_request(request):
    if "target" in request:
        return request
    recipient = request.get("recipient")
    if not isinstance(recipient, str) or not recipient.strip():
        raise Blocked("请提供已采集的会话名称或联系人别名 recipient")
    base = Path(request.get("baseDir") or os.environ.get("AGENT_DATA_DIR") or Path.cwd())
    with mirror_connection(base / ".agent-data/agent.db") as connection:
        row = connection.execute("SELECT payload FROM messaging_state WHERE key='settings'").fetchone()
        settings = json.loads(row[0])["source"] if row else {}
    if not settings.get("database") or not settings.get("accountId"):
        raise Blocked("AgentRoam 尚未配置企微接收账号")
    identity = hashlib.sha256(json.dumps(settings, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()[:24]
    mirror = base / ".agent-data/messaging-wecom" / identity / "mirror.db"
    with mirror_connection(mirror) as connection:
        rows = connection.execute("SELECT RID,name,conversationtype FROM CONVERSATION").fetchall()
    matches = []
    for row in rows:
        name = row["name"] or ""
        alias = re.search(r"\(([a-zA-Z0-9_.@-]+)\)$", name) if row["conversationtype"] == 0 else None
        labels = [name] + ([name[:alias.start()].strip(), alias.group(1)] if alias else [])
        if recipient.strip() in labels:
            matches.append((row, alias))
    if len(matches) != 1:
        raise Blocked("未唯一匹配收件人，请使用完整会话名称或精确联系人别名")
    row, alias = matches[0]
    target = {"conversationId": str(row["RID"]), "name": row["name"],
              "conversationType": {0: "direct", 1: "group"}.get(row["conversationtype"], "unknown")}
    if alias:
        target["peerUserId"] = alias.group(1)
    return {"deliveryId": request.get("deliveryId"), "text": request.get("text"), "accountId": str(settings["accountId"]),
            "clientDatabase": settings["database"], "target": target, "mirror": str(mirror),
            "stateDir": str(base / ".agent-data/messaging-wecom-send")}


def process(request, operation="send", bridge=None, pid=None):
    delivery_id, body = request.get("deliveryId"), request.get("text")
    if not isinstance(delivery_id, str) or not delivery_id or len(delivery_id) > 200 \
            or not isinstance(body, str) or not body.strip() or len(body.encode()) > 20_000:
        raise Blocked("发送 ID 或正文无效")
    root = Path(request["stateDir"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise Blocked("发送记录目录必须仅属于当前用户")
    fingerprint = hashlib.sha256(json.dumps([request["accountId"], request["target"], body], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    path = root / (hashlib.sha256(delivery_id.encode()).hexdigest() + ".json")
    descriptor = os.open(root / "sender.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked("本地发送桥正在处理另一条消息，请稍后重试")
        if path.is_symlink():
            raise Blocked("发送记录不能是符号链接")
        ledger = json.loads(path.read_text()) if path.exists() else None
        if ledger:
            if ledger.get("fingerprint") != fingerprint:
                raise Blocked("相同发送 ID 对应的收件人或正文发生变化")
            if ledger["status"] == "sent":
                return {"status": "sent", "receipt": ledger["receipt"]}
            if ledger.get("submittedAt"):
                try:
                    found = receipt(request, ledger)
                except (sqlite3.Error, OSError, Blocked):
                    return {"status": "unknown", "error": "接收侧回执暂不可读；不会重复提交"}
                if found:
                    ledger.update(status="sent", receipt=found)
                    private_json(path, ledger)
                    return {"status": "sent", "receipt": found}
                return {"status": "unknown", "error": "未取得唯一的本人已发送记录；不会重复提交"}
            if ledger["status"] == "preparing":
                return {"status": "blocked", "error": "上一次准备中断，请核对企微草稿；未自动重新输入"}
        if operation == "verify":
            return {"status": "blocked", "error": "没有已提交的本地发送记录"}
        # Resolve the backend only for a new attempt, never while checking an existing intent.
        mode = os.environ.get("AGENT_WECOM_SENDER")
        if bridge is None:
            if mode == "inject" or (mode != "gui" and probe_inject_socket()):
                bridge = InjectBridge()
            else:
                bridge = NativeBridge(request.get("app", DEFAULT_APP))
        if getattr(bridge, "nameOnly", False) or getattr(bridge, "legacyNameOnly", False) \
                or getattr(bridge, "protocol", PROTOCOL) != PROTOCOL:
            raise Blocked("不支持旧版按名称发送的企微注入桥，请使用协议 v2")
        baseline = verify_target(request)
        use_inject = isinstance(bridge, InjectBridge)
        ledger = {"deliveryId": delivery_id, "fingerprint": fingerprint, "status": "preparing", "baselineLid": baseline,
                  "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "conversationId": request["target"]["conversationId"],
                  "transport": "local-injection" if use_inject else "local-accessibility"}
        private_json(path, ledger)
        window = None
        target = None
        header = None
        pinned = None
        if use_inject:
            # Status + read-only preflight must both succeed before any submission intent is recorded.
            try:
                pinned = bridge.call("preflight", request=request)
            except Exception as error:
                ledger.update(status="blocked", error=str(error))
                private_json(path, ledger)
                return {"status": "blocked", "error": str(error)}
        else:
            # 草稿/会话校验必须在 try 之外抛 Blocked，保持与原有 GUI 流程一致的语义
            pid = pid or request.get("pid") or client_pid(bridge)
            verify_client_database(pid, request.get("clientDatabase"))
            window = main_window(bridge.call("inspect", pid, compact=True))
            if editor(window)["value"]:
                raise Blocked("企微当前会话已有草稿，未覆盖或切换会话")
            accepted(bridge.call("selectConversation", pid, window=window["index"], windowTitle=window["title"], chatTitle=request["target"]["name"]))
            window = main_window(bridge.call("inspect", pid, compact=True))
            target, header = chat_controls(window, request["target"]["name"])
            if target["value"]:
                raise Blocked("目标会话已有草稿，未覆盖")
        try:
            if use_inject:
                # 一次发送调用，携带预检时锁定的进程、实例、账号和会话身份。
                ledger.update(status="submitting", submittedAt=time.time())
                private_json(path, ledger)
                result = bridge.call("send", request=request, pinned=pinned)
                if result.get("status") == "blocked":
                    ledger.update(status="blocked", error=str(result.get("error") or "注入发送被拒绝"))
                    ledger.pop("submittedAt", None)
                    private_json(path, ledger)
                    return {"status": "blocked", "error": ledger["error"]}
                if result.get("status") not in ("blocked", "unknown"):
                    raise Blocked("注入发送未返回可核验的提交结果")
            else:
                accepted(bridge.call("paste", pid, **control_args(window, target), text=body, chatTitle=request["target"]["name"], headerPath=header["path"]))
                window = main_window(bridge.call("inspect", pid, compact=True))
                target, header = chat_controls(window, request["target"]["name"])
                if target["value"] != body:
                    raise Blocked("准备后的正文与请求不一致，未提交")
                ledger.update(status="submitting", submittedAt=time.time())
                private_json(path, ledger)
                result = bridge.call("submit", pid, **control_args(window, target), text=body, chatTitle=request["target"]["name"], headerPath=header["path"])
                if result.get("status") == "blocked":
                    ledger.update(status="blocked", error=str(result.get("error") or "提交前检查未通过"))
                    ledger.pop("submittedAt", None)
                    private_json(path, ledger)
                    return {"status": "blocked", "error": ledger["error"]}
            ledger["status"] = "submitted" if result.get("status") == "submitted" else "unknown"
            private_json(path, ledger)
            return {"status": "unknown", "submitted": True, "error": "已提交企微，等待接收侧核验本人发送记录"}
        except Exception as error:
            ledger.update(status="unknown" if ledger.get("submittedAt") else "blocked", error=str(error))
            private_json(path, ledger)
            return {"status": ledger["status"], "error": "发送结果尚未确认，请核对原会话；不会自动重发" if ledger.get("submittedAt") else str(error)}


if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(65_537)
        if len(data) > 65_536:
            raise Blocked("发送参数过大")
        request = json.loads(data)
        operation = sys.argv[1] if len(sys.argv) > 1 else "send"
        if operation not in ("send", "verify"):
            raise Blocked("不支持该发送桥操作")
        result = process(resolve_request(request), operation)
    except Blocked as error:
        result = {"status": "blocked", "error": str(error)}
    except Exception as error:
        result = {"status": "unknown", "error": "本地发送流程中断，请核对原会话；不会自动重发：" + str(error)}
    print(json.dumps(result, ensure_ascii=False))
