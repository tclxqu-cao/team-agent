#!/usr/bin/env python3
"""Own-account WeCom reader. No injection; never writes database/WAL/SHM bytes."""
import base64
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
from codec import AES, SQLITE_HEADER, decrypt_page, derive_base_key, wal_checksum


def fields(data):
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
        if not number:
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


def read_batch(config):
    source = Path(config["database"])
    cursor = config.get("cursor") or {}
    cache = Path(config["cacheDir"])
    mirror, generation, immutable = prepare_mirror(source, config["accountId"], cache)
    previous = cursor.get("generation")
    lid = int(cursor.get("lid", 0)) if previous in (None, generation) else 0
    since = int(cursor.get("since", datetime.datetime.now().timestamp()))
    uri = "file:" + str(mirror) + "?mode=ro" + ("&immutable=1" if immutable else "")
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA writable_schema=ON")
        connection.execute("BEGIN")
        rows = connection.execute(
            "SELECT * "
            "FROM MESSAGE WHERE LID>? AND send_time>=? ORDER BY LID LIMIT 200", (lid, since)
        ).fetchall()
        messages = []
        for row in rows:
            local_id, rid, conversation, seq, sender, kind, sent, content, extras, refer, flag, msg_type = (
                row[key] for key in ("LID", "RID", "conv_id", "seq", "sender_id", "content_type", "send_time", "content", "extras", "refer", "flag", "message_type"))
            content = content or b""
            try:
                decoded = decode_body(content, kind)
            except (ValueError, UnicodeDecodeError):
                decoded = {"text": "", "displayText": "", "mentionTargets": [], "segments": [], "decodeError": "正文结构尚未识别"}
            try:
                named = connection.execute("SELECT name FROM CONVERSATION WHERE RID=?", (conversation,)).fetchone()
                name = named[0] if named else ""
            except sqlite3.DatabaseError:
                name = ""
            stable = "rid:" + str(rid) if rid else "seq:" + str(seq) + ":" + str(sender) + ":" + str(sent) + ":" + hashlib.sha256(content).hexdigest()
            messages.append({
                "sourceId": stable, "connectionId": "wecom:" + str(config["accountId"]), "channel": "wecom",
                "conversationId": str(conversation), "conversationName": name, "senderId": str(sender),
                "text": decoded["text"], "occurredAt": datetime.datetime.fromtimestamp(sent, datetime.timezone.utc).isoformat(),
                "directMention": str(config["accountId"]) in decoded["mentionTargets"], "ownMessage": str(sender) == str(config["accountId"]),
                "raw": {"LID": str(local_id), "RID": str(rid), "conv_id": str(conversation), "seq": str(seq),
                        "sender_id": str(sender), "content_type": kind, "send_time": str(sent), "flag": flag,
                        "message_type": msg_type, "refer": str(refer), "contentBase64": base64.b64encode(content).decode(),
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
        result = discover() if "--discover" in sys.argv else read_batch(json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=False))
    except PermissionError:
        print(json.dumps({"error": "macOS 拒绝读取企微数据目录，请为运行 AgentRoam 的应用或终端授予完全磁盘访问权限"}))
        sys.exit(2)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(2)
