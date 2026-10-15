# Desktop GitHub release implementation plan

> **For the main agent:** Implement directly in this session. Do not dispatch subagents. Run affected tests after development.

**Goal:** Publish Windows x64 NSIS and macOS arm64 DMG installers with matching native-console runtime components and verified GitHub download links.

**Architecture:** Bundle versioned launcher/runtime tarballs in each installer. Validate their checksums before npm installs them into the user-owned version directory. Managed Node and Codex keep the existing first-launch download flow. Use an isolated source snapshot so packaging cannot alter the running service or concurrent website work.

**Tech stack:** Electron, electron-builder, Bun, Node 22, npm tarballs, GitHub Releases.

## Constraints

- Preserve unrelated dirty files and concurrent commits. Do not publish npm packages or restart existing services.
- Use a desktop-specific prerelease tag and private bundled runtime versions; do not change public CLI download scripts.
- Keep secrets, local configuration, sessions and data out of source snapshots and installers.
- Distinguish cross-built installer validation from native Windows installation and physical phone acceptance.

## Tasks

- [x] Add a checksum-verified bundled-runtime installation source to desktop bootstrap, with missing/tampered/version-mismatch tests.
- [x] Create isolated source snapshot from tracked sources and the pairing implementation. Build current Web console, native runtimes and desktop shell.
- [x] Stage and audit runtime tarballs; create target-specific bundled manifests and build Windows NSIS / macOS DMG.
- [x] Inspect packaged content, verify a cold bundled install on available macOS and perform available Windows checks.
- [x] Publish a GitHub desktop prerelease with source provenance, checksums and direct assets; download and hash-check remote files.
- [x] Confirm the website's existing asset selector accepts the release; capture reusable findings in wiki.

## Final unit test verification

- [x] Run runtime inventory, bundled-source and desktop bootstrap tests, desktop TypeScript compilation and focused native pairing tests. Fix any failures before publication.

Wake-word model weights are excluded. Both ASAR, external resource and bundled tarball scans report no matches; first-launch bootstrap does not download them.

Final result: desktop-v0.2.0-preview.21 published. Exact Windows installer acceptance run 38762603351 passed; full anonymous Windows/macOS downloads match SHA256SUMS; website selector chooses both assets. Native camera/physical-device and real OS desktop-control acceptance remain separate outstanding checks. Validation report: /tmp/agentroam-desktop-release-20261015/validation.json.
