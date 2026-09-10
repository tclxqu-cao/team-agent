#!/usr/bin/env bash
# Compiles the desktop-input Swift helper into assets/bin for dev runs and electron-builder packaging.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p assets/bin
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found; skip building desktop-input (Xcode command line tools required)" >&2
  exit 0
fi
swiftc -O -o assets/bin/desktop-input native/desktop-input.swift
echo "built assets/bin/desktop-input"
