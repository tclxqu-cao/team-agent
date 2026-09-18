#include "remote.hpp"
#include <cstddef>
#include <cstring>
#include <wtsapi32.h>

namespace remote {
// WTSSessionInfoEx reports the interactive-session lock state directly; the
// plain WTSConnectState check in desktopAvailable() cannot tell "locked" from
// "logged off" and the OpenInputDesktop probe cannot run while locked.
// The MSVC and MinGW headers nest WTSINFOEXW members under different names,
// so the level-1 SessionState is read at its documented byte offset instead.
bool sessionLocked() {
    DWORD session = 0, bytes = 0; LPWSTR buffer = nullptr;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &session) || session == 0) return false;
    if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session, WTSSessionInfoEx, &buffer, &bytes)) return false;
    bool locked = false;
    static_assert(offsetof(WTSINFOEXW, Level) == 0 && offsetof(WTSINFOEXW, Data) == 8, "unexpected WTSINFOEXW layout");
    static_assert(offsetof(WTSINFOEX_LEVEL1, SessionState) == 4, "unexpected WTSINFOEX_LEVEL1 layout");
    if (bytes >= 8 + 4 + 4) {
        LONG state = 0;
        std::memcpy(&state, reinterpret_cast<const char*>(buffer) + 8 + 4, sizeof(state));
        locked = state == 0;  // WTS_SESSIONSTATE_LOCK (swapped by a Windows 7 bug)
    }
    WTSFreeMemory(buffer);
    return locked;
}

static void wakeOnce() {
    // One-shot display requirement resets the monitor idle timer and powers
    // the panel back on. ES_CONTINUOUS is deliberately absent — each call is
    // scoped to this thread and expires after the reset.
    SetThreadExecutionState(ES_DISPLAY_REQUIRED);
    // Panels that ignore power requests still wake on synthetic pointer input.
    INPUT event{}; event.type = INPUT_MOUSE;
    event.mi.dwFlags = MOUSEEVENTF_MOVE;
    event.mi.dx = 1; SendInput(1, &event, sizeof(event));
    event.mi.dx = -1; SendInput(1, &event, sizeof(event));
}

Power::~Power() {
    {std::lock_guard<std::mutex> guard(mutex); stop = true; held = false;}
    signal.notify_all();
    if (keeper.joinable()) keeper.join();
}

void Power::hold(bool on) {
    {
        std::lock_guard<std::mutex> guard(mutex);
        if (stop) return;
        held = on;
        if (on && !keeper.joinable()) keeper = std::thread([this] {
            std::unique_lock<std::mutex> guard(mutex);
            while (!stop) {
                if (!held) { SetThreadExecutionState(ES_CONTINUOUS); signal.wait(guard, [this] { return stop || held; }); continue; }
                SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED);
                signal.wait(guard, [this] { return stop || !held; });
            }
            SetThreadExecutionState(ES_CONTINUOUS);
        });
    }
    signal.notify_all();
}

Json Power::command(const Json& cmd) {
    const auto op = cmd.at("op").get<std::string>();
    if (op == "wake") { wakeOnce(); return {{"ok", true}}; }
    if (op == "lock") {
        if (!LockWorkStation()) throw std::runtime_error("锁屏失败：LockWorkStation 被系统拒绝");
        return {{"ok", true}};
    }
    if (op == "keep-display") {
        const auto on = cmd.at("on").get<bool>();
        hold(on);
        return {{"ok", true}};
    }
    throw std::runtime_error("Unknown power operation");
}
}
