# Windows CLI desktop helper

Supports Windows 10/11 x64 in the current user's interactive default desktop.
The existing local pairing/authorization endpoint enables sharing. The helper
uses inherited stdin/stdout JSON lines, DXGI Desktop Duplication, WIC previews,
synchronous Media Foundation H264 and SendInput. It opens no network listener.

Build with `node scripts/build-windows-remote-helper.mjs` from an x64 MSVC
Developer terminal, or with `mingw-w64` installed on macOS/Linux. The default
outputs are `packages/server/native/.build-remote/windows/agentroam-remote-desktop.exe`
and `agentroam-remote-unlock.exe`.
The source server resolves this development binary; packaged runtimes use
`runtime/native/agentroam-remote-desktop.exe` and
`runtime/native/agentroam-remote-unlock.exe`. `AGENT_WINDOWS_CXX` selects a
compiler; `AGENT_WINDOWS_REMOTE_HELPER_OUTPUT` selects the output path. Users
of the packaged CLI need neither compiler nor .NET. Windows N installations
need the Windows Media Feature Pack.

The build downloads nlohmann/json 3.11.3 with a pinned SHA256, retaining its MIT
notice in the runtime. MinGW builds statically link compiler runtime libraries.

## Verification

- Host-independent algorithms: compile/run `algorithms-test.cpp` using C++17.
- On Windows: `node scripts/verify-windows-remote-helper.mjs` checks algorithms
  and a synthetic Media Foundation encode, without capturing or sending input.
- From an unlocked Windows terminal: append `--interactive` to verify actual
  DXGI/JPEG, display switching, quality switching and H264 output.
- Visible acceptance still requires a paired phone: view moving desktop content,
  take control, click/drag/scroll, type ASCII and Chinese, use Ctrl+C/Ctrl+V,
  switch a monitor with a negative origin and mixed DPI, disconnect while holding
  a key/button, disable sharing, lock/unlock and open/dismiss UAC locally.

Lock/UAC/disconnected sessions suspend capture and release held input; restoring
an interactive default desktop permits reconnection. This is a user process,
not a Session 0 service or a UIAccess/elevated process. Secure desktop login,
Ctrl+Alt+Delete and elevated-window control are not supported. Headless CI and
cross-compilation do not establish interactive desktop or phone acceptance.
