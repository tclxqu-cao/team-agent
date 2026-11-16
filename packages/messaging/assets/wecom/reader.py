#!/usr/bin/env python3
"""Own-account WeCom reader. No injection; never writes database/WAL/SHM bytes."""
import base64
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
from codec import AES, SQLITE_HEADER, decrypt_page, derive_base_key, wal_checksum


def fields(data, allow_zero=False):
    def varint(offset):
        value = 0
        for shift in range(0, 70, 7):
            if offset >= len(data):
                raise ValueError("truncated protobuf")
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value, offset
        raise ValueError("invalid protobuf varint")
    offset = 0
    while offset < len(data):
        key, offset = varint(offset)
        number, wire = key >> 3, key & 7
        if not number and not allow_zero:
            raise ValueError("invalid protobuf field")
        if wire == 0:
            value, offset = varint(offset)
        elif wire in (1, 5):
            length = 8 if wire == 1 else 4
            value = data[offset:offset + length]
            offset += length
            if len(value) != length:
                raise ValueError("truncated protobuf fixed field")
        elif wire == 2:
            length, offset = varint(offset)
            if offset + length > len(data):
                raise ValueError("truncated protobuf bytes")
            value, offset = data[offset:offset + length], offset + length
        else:
            raise ValueError("unsupported protobuf wire")
        yield number, wire, value


def decode_body(data, content_type=0):
    text, display, mentions, segments = [], [], [], []
    if content_type not in (0, 2):
        # Markdown/attachments do not acquire direct-mention semantics by text matching.
        return {"text": "", "displayText": "", "mentionTargets": [], "segments": []}
    for number, wire, segment in fields(data):
        if number != 1 or wire != 2:
            continue
        values = list(fields(segment))
        kind = next((value for n, w, value in values if n == 1 and w == 0), None)
        payloads = [value for n, w, value in values if n == 2 and w == 2]
        segments.append({"kind": kind})
        for payload in payloads:
            inner = list(fields(payload))
            if kind == 0:
                part = next((value.decode("utf-8", "strict") for n, w, value in inner if n == 1 and w == 2), "")
                text.append(part)
                display.append(part)
            elif kind == 5:
                vid = next((str(value) for n, w, value in inner if n == 1 and w == 0), None)
                if vid:
                    mentions.append(vid)
                label = next((value.decode("utf-8", "replace") for n, w, value in inner if n == 2 and w == 2), vid or "")
                display.append("@" + label)
            # Quote/forward/attachment payloads are kept raw, never recursively treated as mentions.
    return {"text": "".join(text), "displayText": "".join(display), "mentionTargets": mentions, "segments": segments}


def conversation_names(connection):
    """RID -> display name. 直聊会话的 name 即 '中文名(账号)'，RID 等于对方 VID。"""
    names = {}
    for row in connection.execute("SELECT RID, name, conversationtype FROM CONVERSATION"):
        if row["RID"] is None or not row["name"]:
            continue
        names[str(row["RID"])] = {"name": row["name"], "conversationType": row["conversationtype"]}
    return names


def group_list(connection):
    """全量群列表：conversationtype=1 视为群，exited=0 为仍在群。"""
    groups = []
    for row in connection.execute(
        "SELECT RID, name, creater_id, conversationtype, exited, hidden "
        "FROM CONVERSATION WHERE conversationtype=1 ORDER BY RID"
    ):
        groups.append({
            "conversationId": str(row["RID"]),
            "name": row["name"] or "",
            "createrId": str(row["creater_id"]) if row["creater_id"] is not None else "",
            "conversationType": row["conversationtype"],
            "exited": row["exited"],
            "hidden": row["hidden"],
        })
    return groups


def session_plain(config):
    """解密 Messages1/Session.db（与 Info.db 同 VID key）为明文镜像；带 mtime 缓存。"""
    source = Path(config["database"]).parent / "Session.db"
    cache = Path(config["cacheDir"])
    out = cache / "Session.db.plain"
    if not source.exists():
        return None
    if out.exists() and out.stat().st_mtime >= source.stat().st_mtime:
        return out
    account = int(config["accountId"])
    aes = AES()
    base = derive_base_key(struct.pack("<Q", account))
    frozen_dir = cache / "frozen"
    frozen_dir.mkdir(parents=True, exist_ok=True)
    with frozen_source(source, str(frozen_dir)) as (snap, generation, _):
        data = snap.read_bytes()
    size = int.from_bytes(data[16:18], "big")
    size = 65536 if size == 1 else size
    temporary = out.with_suffix(".tmp")
    temporary.write_bytes(b"".join(
        decrypt_page(aes, data[n:n + size], base, n // size + 1) for n in range(0, len(data), size)))
    os.replace(temporary, out)
    return out


def contact_directory(config):
    """全量通讯录（Session.db USER/DEPARTMENT 表）：VID -> {name, job, departmentId, department, corpid}。"""
    plain = session_plain(config)
    users = {}
    if not plain:
        return users
    connection = sqlite3.connect(str(plain))
    connection.row_factory = sqlite3.Row
    try:
        departments = {}
        for row in connection.execute("SELECT RID, name FROM DEPARTMENT"):
            if row["RID"] is not None:
                departments[str(row["RID"])] = row["name"] or ""
        heads = {}
        try:
            for row in connection.execute("SELECT UID, departmentid FROM MYHEAD ORDER BY id"):
                uid = str(row["UID"]) if row["UID"] is not None else ""
                if uid and uid not in heads and row["departmentid"] is not None:
                    heads[uid] = str(row["departmentid"])
        except sqlite3.OperationalError:
            pass
        for row in connection.execute("SELECT RID, name, job, corpid FROM USER"):
            if row["RID"] is None:
                continue
            dept_id = heads.get(str(row["RID"]), "")
            users[str(row["RID"])] = {
                "name": row["name"] or "", "job": row["job"] or "",
                "departmentId": dept_id, "department": departments.get(dept_id, ""),
                "corpid": str(row["corpid"]) if row["corpid"] is not None else "",
            }
    finally:
        connection.close()
    return users


def group_members(connection, conv_key_prefix, users=None):
    """解 CONV_MEMBER_DATA.member_bin：字段 1=成员 VID、2=加入时间、3=邀请人 VID。
    conv_key 形如 '1_<RID>_0'，按开头 '1_<RID>_' 匹配。users 提供则附姓名。"""
    prefix = "1_" + str(conv_key_prefix) + "_"
    out = []
    for row in connection.execute(
        "SELECT conv_key, member_bin FROM CONV_MEMBER_DATA WHERE conv_key LIKE ?", (prefix + "%",)
    ):
        blob = row["member_bin"] or b""
        members = []
        for number, wire, segment in fields(blob, allow_zero=True):
            # 顶层是重复的 field 0 长度块，每块一个成员
            if wire != 2 or not segment:
                continue
            try:
                inner = list(fields(segment))
            except ValueError:
                continue
            vid = next((value for n, w, value in inner if n == 1 and w == 0), None)
            if vid is None:
                continue
            joined = next((value for n, w, value in inner if n == 2 and w == 0), None)
            inviter = next((value for n, w, value in inner if n == 3 and w == 0), None)
            members.append({
                "vid": str(vid),
                "name": (users or {}).get(str(vid), {}).get("name") or None,
                "joinedAt": joined,
                "inviterVid": str(inviter) if inviter is not None else None,
                "inviterName": (users or {}).get(str(inviter), {}).get("name") if inviter is not None else None,
            })
        out.append({"convKey": row["conv_key"], "members": members})
    return out


def committed_frames(data, page_size):
    if not data:
        return [], 0, ""
    if len(data) < 32:
        raise ValueError("WAL header is incomplete")
    magic = int.from_bytes(data[:4], "big")
    size = int.from_bytes(data[8:12], "big") or page_size
    if magic not in (0x377F0682, 0x377F0683) or size != page_size:
        raise ValueError("WAL header does not match database")
    stored = tuple(int.from_bytes(data[n:n + 4], "big") for n in (24, 28))
    order = next((o for o in ("little", "big") if wal_checksum(data[:24], 0, 0, o) == stored), None)
    if order is None:
        raise ValueError("WAL header checksum failed")
    checksum = stored
    frames, committed = [], 0
    for offset in range(32, len(data) - (24 + size) + 1, 24 + size):
        frame = data[offset:offset + 24 + size]
        if frame[8:16] != data[16:24]:
            break
        checksum = wal_checksum(frame[:8], *checksum, order)
        checksum = wal_checksum(frame[24:], *checksum, order)
        if checksum != tuple(int.from_bytes(frame[n:n + 4], "big") for n in (16, 20)):
            break
        page, db_size = struct.unpack(">II", frame[:8])
        if page < 1:
            raise ValueError("invalid WAL page")
        frames.append((page, db_size, frame[24:]))
        if db_size:
            committed = len(frames)
    return frames[:committed], committed, data[:24].hex()


@contextlib.contextmanager
def frozen_source(source, directory):
    """SQLite unix VFS locks start at 120: CKPT=121, READ0=123, READ1=124.

    Shared locks prevent checkpoint writes and WAL reset while the APFS clone
    and committed WAL prefix are captured. They never alter source bytes.
    """
    shm = Path(str(source) + "-shm")
    if not shm.is_file():
        raise RuntimeError("企微 WAL 尚未就绪，请保持企微登录后重试")
    with tempfile.TemporaryDirectory(dir=directory) as temp:
        with shm.open("rb") as lock:
            for offset in (121, 123, 124):
                fcntl.lockf(lock, fcntl.LOCK_SH | fcntl.LOCK_NB, 1, offset, os.SEEK_SET)
            before = source.stat()
            wal = Path(str(source) + "-wal")
            data = wal.read_bytes() if wal.exists() else b""
            frozen = Path(temp) / "source.db"
            # cp -c clones on APFS. The fallback remains under both SQLite locks.
            cloned = False
            if sys.platform == "darwin":
                cloned = subprocess.run(["/bin/cp", "-c", str(source), str(frozen)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            if not cloned:
                shutil.copyfile(source, frozen)
            after = source.stat()
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                raise RuntimeError("企微数据库在快照期间发生变化，暂缓采集")
        # Release source locks before decryption and integrity checks.
        yield frozen, data, str(before.st_dev) + ":" + str(before.st_ino)


def prepare_mirror(source, account, cache):
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(cache, 0o700)
    mirror, state_file = cache / "mirror.db", cache / "mirror.json"
    try:
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
    except (ValueError, OSError):
        state = {}
    # A plaintext source is an explicit reader/fixture bridge; SQLite owns its snapshot.
    with source.open("rb") as file:
        clear = file.read(16) == SQLITE_HEADER
    if clear:
        connection = sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True)
        try:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("BEGIN")
            generation = "plain:" + str(source.stat().st_ino)
            return source, generation, False
        finally:
            connection.close()
    account_number = int(account)
    base_key, aes = derive_base_key(struct.pack("<Q", account_number)), AES()
    with frozen_source(source, cache) as (frozen, data, identity):
        with frozen.open("rb") as file:
            header = file.read(24)
        size = int.from_bytes(header[16:18], "big")
        size = 65536 if size == 1 else size
        if size < 512 or size > 65536 or size & (size - 1):
            raise ValueError("不支持的企微数据库页大小")
        frames, count, salt = committed_frames(data, size)
        generation = identity + ":" + salt
        rebase = not mirror.exists() or state.get("generation") != generation or state.get("frames", 0) > count
        destination = cache / "mirror.next" if rebase else mirror
        if rebase:
            with frozen.open("rb") as file, destination.open("wb") as output:
                number = 1
                while True:
                    page = file.read(size)
                    if not page:
                        break
                    if len(page) != size:
                        raise ValueError("企微主库页不完整")
                    output.write(decrypt_page(aes, page, base_key, number))
                    number += 1
            start = 0
        else:
            start = int(state.get("frames", 0))
        with destination.open("r+b") as output:
            for number, db_size, payload in frames[start:]:
                output.seek((number - 1) * size)
                output.write(decrypt_page(aes, payload, base_key, number))
            if frames:
                output.truncate(frames[-1][1] * size)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(destination, 0o600)
        if rebase:
            destination.replace(mirror)
            with sqlite3.connect("file:" + str(mirror) + "?mode=ro&immutable=1", uri=True) as connection:
                connection.execute("PRAGMA writable_schema=ON")
                result = connection.execute("PRAGMA quick_check('MESSAGE')").fetchall()
                if result != [("ok",)]:
                    mirror.unlink(missing_ok=True)
                    raise ValueError("企微消息快照一致性检查未通过")
        temporary = cache / "mirror-state.next"
        temporary.write_text(json.dumps({"generation": generation, "frames": count}))
        os.chmod(temporary, 0o600)
        temporary.replace(state_file)
    return mirror, generation, True


def discover():
    if sys.platform != "darwin":
        return {"sources": [], "error": "本地企微监听目前支持 macOS；其他渠道可通过接入适配器扩展"}
    documents = Path(os.environ.get("AGENT_WECOM_DATA_DIR", str(Path.home() / "Library/Containers/com.tencent.WeWorkMac/Data/Documents")))
    if not documents.exists():
        return {"sources": [], "error": "未找到本机企业微信，请先安装并登录"}
    try:
        list(documents.iterdir())  # glob suppresses permission errors; surface them instead.
        accounts = [p.name[4:] for p in (documents / "cefcache").iterdir() if p.name.startswith("wew_") and p.name[4:].isdigit()]
        databases = list((documents / "Profiles").glob("*/Messages1/Info.db"))
    except PermissionError:
        return {"sources": [], "error": "macOS 拒绝读取企微数据目录，请为运行 AgentRoam 的应用或终端授予完全磁盘访问权限"}
    sources = []
    for database in databases:
        with database.open("rb") as file:
            header = file.read(4096)
        for account in accounts:
            try:
                if decrypt_page(AES(), header, derive_base_key(struct.pack("<Q", int(account))), 1).startswith(SQLITE_HEADER):
                    sources.append({"database": str(database), "accountId": account})
            except (ValueError, RuntimeError):
                pass
    return {"sources": sources, "error": None if sources else "未发现支持的企微账号数据库，请确认本机版本与登录状态"}


def open_mirror(config):
    """按 config 准备明文镜像并返回只读连接；调用方负责 close()。"""
    source = Path(config["database"])
    cache = Path(config["cacheDir"])
    mirror, generation, immutable = prepare_mirror(source, config["accountId"], cache)
    uri = "file:" + str(mirror) + "?mode=ro" + ("&immutable=1" if immutable else "")
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    return connection, generation


def static_queries(config, groups=False, members_for=None, contacts=False):
    """只读静态资料查询：群列表 / 群成员 / 全量通讯录；不触碰消息表与 cursor。"""
    connection, _ = open_mirror(config)
    try:
        users = contact_directory(config) if (members_for is not None or contacts) else None
        result = {}
        if contacts:
            result["contacts"] = users
        if groups:
            result["groups"] = group_list(connection)
        if members_for is not None:
            result["members"] = group_members(connection, members_for, users)
            result["conversationId"] = str(members_for)
        return result
    finally:
        connection.close()


def read_batch(config):
    cursor = config.get("cursor") or {}
    connection, generation = open_mirror(config)
    previous = cursor.get("generation")
    lid = int(cursor.get("lid", 0)) if previous in (None, generation) else 0
    since = int(cursor.get("since", datetime.datetime.now().timestamp()))
    try:
        connection.execute("PRAGMA writable_schema=ON")
        connection.execute("BEGIN")
        rows = connection.execute(
            "SELECT * "
            "FROM MESSAGE WHERE LID>? AND send_time>=? ORDER BY LID LIMIT 200", (lid, since)
        ).fetchall()
        names = conversation_names(connection)   # 一次预载，避免逐条查 CONVERSATION
        try:
            users = contact_directory(config)     # Session.db USER 表：全量 VID→姓名
        except Exception:
            users = {}
        messages = []
        for row in rows:
            local_id, rid, conversation, seq, sender, kind, sent, content, extras, refer, flag, msg_type = (
                row[key] for key in ("LID", "RID", "conv_id", "seq", "sender_id", "content_type", "send_time", "content", "extras", "refer", "flag", "message_type"))
            content = content or b""
            try:
                decoded = decode_body(content, kind)
            except (ValueError, UnicodeDecodeError):
                decoded = {"text": "", "displayText": "", "mentionTargets": [], "segments": [], "decodeError": "正文结构尚未识别"}
            named = names.get(str(conversation))
            name = named["name"] if named else ""
            conversation_type = named["conversationType"] if named else None
            sender_named = names.get(str(sender))
            # 直聊会话名即 '中文名(账号)'；USER 表（Session.db）优先——覆盖无直聊会话的群成员/机器人。
            sender_name = sender_named["name"] if sender_named else ""
            user_entry = users.get(str(sender))
            if user_entry and user_entry["name"]:
                sender_name = user_entry["name"]
            kind_name = "direct" if conversation_type == 0 else "group" if conversation_type == 1 else "unknown"
            alias = re.search(r"\(([a-zA-Z0-9_.@-]+)\)$", name or "") if kind_name == "direct" else None
            stable = "rid:" + str(rid) if rid else "seq:" + str(seq) + ":" + str(sender) + ":" + str(sent) + ":" + hashlib.sha256(content).hexdigest()
            messages.append({
                "sourceId": stable, "connectionId": "wecom:" + str(config["accountId"]), "channel": "wecom",
                "conversationId": str(conversation), "conversationName": name, "senderId": str(sender),
                "senderName": sender_name or None,
                "conversationType": kind_name, **({"peerUserId": alias.group(1)} if alias else {}),
                "text": decoded["text"], "occurredAt": datetime.datetime.fromtimestamp(sent, datetime.timezone.utc).isoformat(),
                "directMention": str(config["accountId"]) in decoded["mentionTargets"], "ownMessage": str(sender) == str(config["accountId"]),
                "raw": {"LID": str(local_id), "RID": str(rid), "conv_id": str(conversation), "seq": str(seq),
                        "sender_id": str(sender), "content_type": kind, "send_time": str(sent), "flag": flag,
                        "message_type": msg_type, "refer": str(refer), "conversationType": conversation_type, "contentBase64": base64.b64encode(content).decode(),
                        "extrasBase64": base64.b64encode(extras or b"").decode(),
                        "columns": {key: {"base64": base64.b64encode(value).decode()} if isinstance(value, bytes)
                                    else str(value) if isinstance(value, int) else value for key, value in dict(row).items()}, **decoded},
            })
        next_lid = rows[-1]["LID"] if rows else max(lid, connection.execute("SELECT COALESCE(MAX(LID),0) FROM MESSAGE").fetchone()[0])
        return {"messages": messages, "cursor": {"generation": generation, "lid": str(next_lid), "since": since}}
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        if "--discover" in sys.argv:
            result = discover()
        elif "--contacts" in sys.argv:
            result = contact_directory(json.load(sys.stdin))
            print(json.dumps(result, ensure_ascii=False))
            sys.exit(0)
        elif "--groups" in sys.argv or "--members" in sys.argv:
            config = json.load(sys.stdin)
            members_for = None
            if "--members" in sys.argv:
                index = sys.argv.index("--members")
                if index + 1 >= len(sys.argv):
                    raise ValueError("--members 需要群 conversationId（CONVERSATION.RID）")
                members_for = sys.argv[index + 1]
            result = static_queries(config, groups="--groups" in sys.argv, members_for=members_for, contacts="--contacts" in sys.argv)
        else:
            result = read_batch(json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=False))
    except PermissionError:
        print(json.dumps({"error": "macOS 拒绝读取企微数据目录，请为运行 AgentRoam 的应用或终端授予完全磁盘访问权限"}))
        sys.exit(2)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(2)
