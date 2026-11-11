#!/usr/bin/env python3
"""Run a bounded, read-only bridge probe and restore the original client. Never sends."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time

ORIGINAL = "/Applications/企业微信.app/Contents/MacOS/企业微信"
SOURCE_HASH = "079eabdc95281c62b4daf7f431124dff53caf5d11ccbe1f8715b2b2f56a4daf2"


def processes(executable):
    result = subprocess.run(["/bin/ps", "-axo", "pid=,stat=,comm="], check=True, capture_output=True, text=True)
    rows = [line.strip().split(None, 2) for line in result.stdout.splitlines()]
    return [int(pid) for pid, state, command in rows if command == executable and not state.startswith("Z")]


def experiment_processes(app):
    result = subprocess.run(["/bin/ps", "-axo", "pid=,stat=,comm="], check=True, capture_output=True, text=True)
    rows = [line.strip().split(None, 2) for line in result.stdout.splitlines()]
    return [int(pid) for pid, state, command in rows if command.startswith(str(app) + "/") and not state.startswith("Z")]


def terminate(pids):
    if not pids:
        return
    script = "import AppKit\nfor pid: Int32 in [" + ",".join(map(str, pids)) + "] { _ = NSRunningApplication(processIdentifier: pid)?.terminate() }"
    subprocess.run(["/usr/bin/swift", "-e", script], check=True, capture_output=True, timeout=60)


def wait_stopped(executable, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not processes(executable):
            return True
        time.sleep(0.25)
    return False


def application_ready(pid):
    script = "import AppKit\nif let app = NSRunningApplication(processIdentifier: " + str(pid) + ") { print(app.isFinishedLaunching ? \"ready\" : \"starting\") }"
    return subprocess.run(["/usr/bin/swift", "-e", script], check=True, capture_output=True, text=True, timeout=30).stdout.strip() == "ready"


def health(endpoint, executable, manifest):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(2)
        channel.connect(str(endpoint))
        peer = int.from_bytes(channel.getsockopt(0, 2, 4), "little", signed=True)  # macOS LOCAL_PEERPID
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.getpeereid(channel.fileno(), ctypes.byref(uid), ctypes.byref(gid)) or uid.value != os.getuid():
            raise RuntimeError("Socket peer does not belong to this user")
        channel.sendall(b'{"cmd":"status"}\n')
        data = b""
        while b"\n" not in data:
            chunk = channel.recv(4096)
            if not chunk:
                raise RuntimeError("Incomplete health response")
            data += chunk
            if len(data) > 65536:
                raise RuntimeError("Health response too large")
    result = json.loads(data.split(b"\n", 1)[0])
    expected = {"ok": True, "protocol": 2, "pid": peer, "appVersion": "5.0.13", "appBuild": "95049",
                "sourceSha256": SOURCE_HASH, "bridgeSourceSha256": manifest["sourceSha256"], "sendingEnabled": False}
    if peer not in processes(executable) or any(result.get(key) != value for key, value in expected.items()) or not result.get("instanceId"):
        raise RuntimeError("Bridge identity, version or read-only mode mismatch")
    return result


def probe(app, output, replace):
    if not replace:
        raise ValueError("Pass --temporarily-replace-original to explicitly authorize normal quit/start/restore")
    executable = str(app / "Contents/MacOS/企业微信")
    library = app / "Contents/MacOS/NativeInjectBridge.dylib"
    if app == Path("/Applications/企业微信.app") or not library.is_file():
        raise ValueError("Provide the new app copy created by prepare-wecom-inject-app.py")
    manifest = json.loads((app / "Contents/Resources/agentroam-inject-manifest.json").read_text())
    if manifest["sourceExecutableSha256"] != SOURCE_HASH:
        raise ValueError("Unsupported app-copy manifest")
    with library.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != manifest["librarySha256"]:
            raise ValueError("App-copy library does not match its build manifest")
    output.mkdir(mode=0o700)  # must be a fresh private directory
    endpoint = output / "b.sock"
    if len(os.fsencode(endpoint)) >= 104:
        raise ValueError("Choose a shorter output path for the macOS Unix socket (maximum 103 bytes)")
    if processes(executable) or experiment_processes(app):
        raise RuntimeError("Experimental client or helper already running; no processes changed")
    report = {"realMessagesSent": False, "sendingEnabled": False, "originalProcessesBefore": processes(ORIGINAL)}
    child = None
    try:
        terminate(report["originalProcessesBefore"])
        if not wait_stopped(ORIGINAL):
            raise RuntimeError("Original client did not exit normally; not starting a shared-profile copy")
        environment = os.environ.copy()
        environment.pop("AGENT_WECOM_INJECT_ALLOW_SEND", None)
        environment.pop("DYLD_INSERT_LIBRARIES", None)
        log = str(output / "client.log")
        # LaunchServices establishes the normal application/CEF launch context.
        # Pass only this experiment's explicit environment; the constructor removes DYLD before helpers spawn.
        command = ["/usr/bin/open", "-n", "-W", "--stdout", log, "--stderr", log,
                   "--env", "AGENT_WECOM_INJECT_ALLOW_SEND=0", "--env", "AGENT_WECOM_INJECT_SOCKET=" + str(endpoint),
                   "--env", "DYLD_INSERT_LIBRARIES=" + str(library), str(app)]
        child = subprocess.Popen(command, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError("Experimental launch exited: " + str(child.returncode))
            try:
                report["health"] = health(endpoint, executable, manifest)
                report["launchedPid"] = report["health"]["pid"]
                break
            except OSError:
                time.sleep(0.3)
        else:
            raise RuntimeError("Bridge did not become healthy within 35 seconds")
        try:
            child.wait(timeout=20)
            raise RuntimeError("Client exited during the stability window: " + str(child.returncode))
        except subprocess.TimeoutExpired:
            report["stableForSeconds"] = 20
        report["applicationFinishedLaunching"] = application_ready(report["launchedPid"])
        if not report["applicationFinishedLaunching"]:
            raise RuntimeError("Bridge loaded, but application did not finish launching; client is not usable")
        report["status"] = "read-only bridge healthy"
    except Exception as error:
        report.update(status="experiment failed", error=str(error))
    finally:
        # Never terminate a pre-existing clone, or force-kill a client that refuses normal quit.
        if child:
            terminate(processes(executable))
        report["cloneStopped"] = wait_stopped(executable) if child else not processes(executable)
        if child:
            terminate(experiment_processes(app))
            deadline = time.monotonic() + 10
            while experiment_processes(app) and time.monotonic() < deadline:
                time.sleep(0.25)
        report["remainingExperimentPids"] = experiment_processes(app)
        if report["cloneStopped"] and report["originalProcessesBefore"] and not processes(ORIGINAL):
            subprocess.run(["/usr/bin/open", "-a", "/Applications/企业微信.app"], check=True, capture_output=True, timeout=30)
            deadline = time.monotonic() + 10
            while not processes(ORIGINAL) and time.monotonic() < deadline:
                time.sleep(0.25)
        report["originalProcessesAfter"] = processes(ORIGINAL)
        with Path(ORIGINAL).open("rb") as stream:
            report["originalUnchanged"] = hashlib.file_digest(stream, "sha256").hexdigest() == SOURCE_HASH
        (output / "health.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        os.chmod(output / "health.json", 0o600)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    restore_failed = bool(report["originalProcessesBefore"]) and not report["originalProcessesAfter"]
    if report.get("status") != "read-only bridge healthy" or not report["cloneStopped"] or report["remainingExperimentPids"] or not report["originalUnchanged"] or restore_failed:
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--application", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="new, short output directory")
    parser.add_argument("--temporarily-replace-original", action="store_true")
    options = parser.parse_args()
    probe(options.application.resolve(strict=True), options.output.absolute(), options.temporarily_replace_original)
