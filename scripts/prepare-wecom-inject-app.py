#!/usr/bin/env python3
"""Prepare an explicitly requested, fresh WeCom experimental app copy; never launch it."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess

# Exact supported executable. Not a general-purpose patcher.
SOURCE_HASH = "079eabdc95281c62b4daf7f431124dff53caf5d11ccbe1f8715b2b2f56a4daf2"
SOURCE = Path("/Applications/企业微信.app")
EXECUTABLE = "Contents/MacOS/企业微信"


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(library, destination):
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Destination already exists; nothing will be removed or overwritten")
    if destination.suffix != ".app" or not destination.parent.is_dir() or destination.parent.is_symlink():
        raise ValueError("Provide a new .app path under an existing directory")
    original_hash = sha256(SOURCE / EXECUTABLE)
    if original_hash != SOURCE_HASH:
        raise ValueError("Installed WeCom executable does not match the supported build")
    info = plistlib.loads((SOURCE / "Contents/Info.plist").read_bytes())
    if (info.get("CFBundleShortVersionString"), info.get("CFBundleVersion")) != ("5.0.13", "95049"):
        raise ValueError("Unsupported WeCom version")
    manifest = json.loads((library.parent / "bridge-manifest.json").read_text())
    if manifest["librarySha256"] != sha256(library) or manifest["sourceExecutableSha256"] != SOURCE_HASH or manifest["protocol"] != 2:
        raise ValueError("Bridge manifest mismatch")
    entitlements = subprocess.run(["/usr/bin/codesign", "--display", "--entitlements", "-", "--xml", str(SOURCE)],
                                 check=True, capture_output=True).stdout
    values = plistlib.loads(entitlements)
    values["com.apple.security.app-sandbox"] = False
    values["com.apple.security.cs.disable-library-validation"] = True
    values["com.apple.security.cs.allow-dyld-environment-variables"] = True
    # No debug entitlement or global system setting changes are needed for startup loading.
    values.pop("com.apple.security.get-task-allow", None)
    destination.mkdir(mode=0o700)  # reserve the path; fail if another experiment claimed it
    subprocess.run(["/usr/bin/ditto", str(SOURCE), str(destination)], check=True)
    target_library = destination / "Contents/MacOS/NativeInjectBridge.dylib"
    subprocess.run(["/bin/cp", str(library), str(target_library)], check=True)
    resources = destination / "Contents/Resources"
    entitlement_file = resources / "agentroam-inject-entitlements.plist"
    with entitlement_file.open("xb") as stream:
        stream.write(plistlib.dumps(values))
    with (resources / "agentroam-inject-manifest.json").open("x") as stream:
        json.dump({**manifest, "sourceApplication": str(SOURCE), "purpose": "local authorized experiment; sending disabled by default"}, stream, indent=2)
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(target_library)], check=True)
    # Do not re-sign nested vendor helpers or use --deep.
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", str(entitlement_file), str(destination)], check=True)
    subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "--verbose=1", str(destination)], check=True)
    if sha256(SOURCE / EXECUTABLE) != original_hash:
        raise RuntimeError("Original executable changed during preparation")
    print(json.dumps({"application": str(destination), "library": str(target_library), "originalUnchanged": True,
                      "sendingEnabled": False, "launchPerformed": False}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    options = parser.parse_args()
    prepare(options.library.resolve(strict=True), options.destination)
