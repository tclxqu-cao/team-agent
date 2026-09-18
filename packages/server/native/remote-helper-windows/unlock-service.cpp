// AgentRoam Windows remote unlock service.
//
// Two roles live in this single executable:
//  - Service (default / --service / --console): runs as LocalSystem, listens
//    on \\.\pipe\agentroam-remote-unlock and serves status/wake/unlock
//    requests from the user-level AgentRoam server.
//  - Injector (--inject): spawned per request inside the console session with
//    a SYSTEM token, attaches the secure Winlogon desktop, wakes the display
//    and (for unlock) types the credentials followed by Enter.
//
// Passwords travel through an inherited anonymous pipe, never the command
// line, disk or logs; the service keeps no credential state. The pipe DACL is
// rebuilt for every connection so only the current console-session user and
// SYSTEM may connect.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <wtsapi32.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

using Json = nlohmann::json;

namespace {
const wchar_t PIPE_NAME[] = L"\\\\.\\pipe\\agentroam-remote-unlock";
const wchar_t SERVICE_NAME[] = L"AgentRoamUnlock";
constexpr DWORD CONNECT_TIMEOUT_MS = 60000;   // unlock may take ~15s (dismiss + type + verify)
constexpr DWORD READ_TIMEOUT_MS = 5000;
constexpr size_t MAX_REQUEST = 4096;

std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), int(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(size, 0);
    WideCharToMultiByte(CP_UTF8, 0, value.data(), int(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}
std::wstring wide(const std::string& value) {
    if (value.empty()) return {};
    int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), int(value.size()), nullptr, 0);
    if (!size) throw std::runtime_error("Invalid UTF-8");
    std::wstring result(size, 0);
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), int(value.size()), result.data(), size);
    return result;
}

template <typename Character>
void secureClear(std::basic_string<Character>& value) {
    if (!value.empty()) SecureZeroMemory(value.data(), value.size() * sizeof(Character));
    value.clear();
}

bool writeBytes(HANDLE handle, const std::string& bytes, bool overlappedIo = false) {
    size_t offset = 0;
    while (offset < bytes.size()) {
        DWORD written = 0;
        if (!overlappedIo) {
            if (!WriteFile(handle, bytes.data() + offset, DWORD(bytes.size() - offset), &written, nullptr) || !written) return false;
        } else {
            OVERLAPPED operation{};
            operation.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
            if (!operation.hEvent) return false;
            const BOOL started = WriteFile(handle, bytes.data() + offset, DWORD(bytes.size() - offset), nullptr, &operation);
            bool ok = true;
            if (!started && GetLastError() != ERROR_IO_PENDING) ok = false;
            else if (!started && WaitForSingleObject(operation.hEvent, READ_TIMEOUT_MS) != WAIT_OBJECT_0) {
                CancelIoEx(handle, &operation);
                GetOverlappedResult(handle, &operation, &written, TRUE);
                ok = false;
            } else if (!GetOverlappedResult(handle, &operation, &written, FALSE)) ok = false;
            CloseHandle(operation.hEvent);
            if (!ok || !written) return false;
        }
        offset += written;
    }
    return true;
}

bool writeLine(HANDLE handle, const Json& value, bool overlappedIo = false) {
    return writeBytes(handle, value.dump() + "\n", overlappedIo);
}

// Reads one newline-terminated request, bailing out when the client stalls.
bool readLine(HANDLE handle, std::string& line) {
    OVERLAPPED overlapped{}; overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!overlapped.hEvent) return false;
    line.clear();
    bool complete = false, ok = true;
    char chunk[512];
    while (!complete && ok) {
        ResetEvent(overlapped.hEvent);
        DWORD read = 0;
        const BOOL started = ReadFile(handle, chunk, sizeof(chunk), nullptr, &overlapped);
        if (!started) {
            if (GetLastError() != ERROR_IO_PENDING) { ok = false; break; }
            if (WaitForSingleObject(overlapped.hEvent, READ_TIMEOUT_MS) != WAIT_OBJECT_0) {
                CancelIoEx(handle, &overlapped);
                GetOverlappedResult(handle, &overlapped, &read, TRUE);
                ok = false;
                break;
            }
        }
        if (!GetOverlappedResult(handle, &overlapped, &read, FALSE)) { ok = false; break; }
        if (!read) { ok = line.empty() ? false : true; break; }  // EOF: accept a trailing unterminated line
        for (DWORD i = 0; i < read; ++i) {
            if (chunk[i] == '\n') { complete = true; break; }
            line += chunk[i];
            if (line.size() > MAX_REQUEST) { ok = false; break; }
        }
    }
    CloseHandle(overlapped.hEvent);
    return ok && complete && !line.empty();
}

DWORD consoleSession() { return WTSGetActiveConsoleSessionId(); }

// The MSVC and MinGW headers nest WTSINFOEXW members under different names,
// so the level-1 SessionState is read at its documented byte offset.
bool sessionLocked(DWORD session) {
    DWORD bytes = 0; LPWSTR buffer = nullptr;
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

bool consoleUserPresent(DWORD session) {
    HANDLE token = nullptr;
    if (!WTSQueryUserToken(session, &token)) return false;
    CloseHandle(token);
    return true;
}

// "D:P(A;;GA;;;SY)" plus the current console-session user, resolved per
// connection so a fast user switch cannot leave the previous owner authorized.
std::wstring pipeSddl(DWORD session) {
    std::wstring sddl = L"D:P(A;;GA;;;SY)";
    HANDLE token = nullptr;
    if (WTSQueryUserToken(session, &token)) {
        DWORD length = 0;
        GetTokenInformation(token, TokenUser, nullptr, 0, &length);
        if (length) {
            std::vector<char> buffer(length);
            if (GetTokenInformation(token, TokenUser, buffer.data(), length, &length)) {
                const auto* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
                LPWSTR sid = nullptr;
                if (ConvertSidToStringSidW(user->User.Sid, &sid)) {
                    sddl += L"(A;;GA;;;" + wide(utf8(sid)) + L")";
                    LocalFree(sid);
                }
            }
        }
        CloseHandle(token);
    }
    return sddl;
}

// ── injector: SYSTEM child inside the console session ───────────────────────

HDESK openDesktopRetry(const wchar_t* name, DWORD timeoutMs) {
    const DWORD allDesktopRights = DESKTOP_CREATEMENU | DESKTOP_CREATEWINDOW | DESKTOP_HOOKCONTROL |
        DESKTOP_JOURNALPLAYBACK | DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP | DESKTOP_WRITEOBJECTS | DESKTOP_ENUMERATE;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
        if (HDESK desktop = OpenDesktopW(name, 0, FALSE, allDesktopRights)) return desktop;
        if (std::chrono::steady_clock::now() >= deadline) return nullptr;
        Sleep(150);
    }
}

std::string inputDesktopName() {
    HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    if (!desktop) return {};
    wchar_t name[128] = {}; DWORD needed = 0;
    GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &needed);
    CloseDesktop(desktop);
    return utf8(name);
}

void jigglePointer() {
    INPUT moves[2] = {};
    moves[0].type = moves[1].type = INPUT_MOUSE;
    moves[0].mi.dwFlags = moves[1].mi.dwFlags = MOUSEEVENTF_MOVE;
    moves[0].mi.dx = 1; moves[1].mi.dx = -1;
    SendInput(2, moves, sizeof(INPUT));
}

void pressVirtualKey(WORD code) {
    INPUT events[2] = {};
    events[0].type = events[1].type = INPUT_KEYBOARD;
    events[0].ki.wVk = code; events[1].ki.wVk = code;
    events[1].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, events, sizeof(INPUT));
}

void typeUnicode(const std::wstring& text) {
    for (wchar_t unit : text) {
        INPUT events[2] = {};
        events[0].type = events[1].type = INPUT_KEYBOARD;
        events[0].ki.wScan = WORD(unit); events[0].ki.dwFlags = KEYEVENTF_UNICODE;
        events[1].ki.wScan = WORD(unit); events[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        if (SendInput(2, events, sizeof(INPUT)) != 2) throw std::runtime_error("type failed");
        Sleep(2);  // keep the logon UI's input queue ahead of the keystrokes
    }
}

bool waitForUnlocked(DWORD timeoutMs) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
        const std::string name = inputDesktopName();
        if (name == "Default") return true;
        if (std::chrono::steady_clock::now() >= deadline) return false;
        Sleep(250);
    }
}

int runInjector(Json& request) {
    const std::string op = request.value("op", std::string("wake"));
    try {
        // The service runs in session 0; desktops live inside the console
        // session's WinSta0, so attach to it first.
        HWINSTA winsta = OpenWindowStationW(L"WinSta0", FALSE, GENERIC_READ | GENERIC_WRITE | WINSTA_ENUMDESKTOPS | WINSTA_READATTRIBUTES);
        if (!winsta) throw std::runtime_error("cannot open WinSta0");
        if (!SetProcessWindowStation(winsta)) throw std::runtime_error("cannot switch window station");
        HDESK desktop = openDesktopRetry(L"Winlogon", 5000);
        if (!desktop) throw std::runtime_error("cannot open Winlogon desktop");
        if (!SetThreadDesktop(desktop)) throw std::runtime_error("cannot attach Winlogon desktop");
        jigglePointer();  // wake the display; any input dismisses the wallpaper
        if (op != "unlock") { writeLine(GetStdHandle(STD_OUTPUT_HANDLE), {{"ok", true}, {"woke", true}}); return 0; }
        auto& encodedPassword = request.at("password").get_ref<std::string&>();
        std::wstring password;
        try { password = wide(encodedPassword); }
        catch (...) { secureClear(encodedPassword); throw; }
        secureClear(encodedPassword);
        if (password.size() > 256) { secureClear(password); writeLine(GetStdHandle(STD_OUTPUT_HANDLE), {{"ok", false}, {"error", "password-too-long"}}); return 1; }
        Sleep(600);
        pressVirtualKey(VK_RETURN);  // reveal the credential field (no-op when already visible)
        Sleep(700);
        bool failed = false;
        try { typeUnicode(password); }
        catch (...) { failed = true; }
        secureClear(password);
        if (failed) throw std::runtime_error("cannot type on the secure desktop");
        pressVirtualKey(VK_RETURN);
        if (waitForUnlocked(9000)) { writeLine(GetStdHandle(STD_OUTPUT_HANDLE), {{"ok", true}}); return 0; }
        pressVirtualKey(VK_RETURN);  // first Enter may have been consumed dismissing the lock screen
        if (waitForUnlocked(6000)) { writeLine(GetStdHandle(STD_OUTPUT_HANDLE), {{"ok", true}}); return 0; }
        writeLine(GetStdHandle(STD_OUTPUT_HANDLE), {{"ok", false}, {"error", "unlock-failed"}});
        return 1;
    } catch (const std::exception& error) {
        writeLine(GetStdHandle(STD_OUTPUT_HANDLE), {{"ok", false}, {"error", error.what()}});
        return 1;
    }
}

Json duplicateConsoleToken(DWORD session, HANDLE& token) {
    HANDLE self = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_SESSIONID | TOKEN_ADJUST_PRIVILEGES, &self))
        return {{"ok", false}, {"error", "cannot open service token"}};
    BOOL success = DuplicateTokenEx(self, MAXIMUM_ALLOWED, nullptr, SecurityAnonymous, TokenPrimary, &token);
    CloseHandle(self);
    if (!success) return {{"ok", false}, {"error", "cannot duplicate service token"}};
    if (!SetTokenInformation(token, TokenSessionId, &session, sizeof(session)))
        return {{"ok", false}, {"error", "cannot retarget token session"}};
    return {{"ok", true}};
}

std::string injectorRequestLine(const std::string& op, const std::string& password) {
    Json payload = {{"op", op}};
    if (!password.empty()) payload["password"] = password;
    std::string request = payload.dump() + "\n";
    if (payload.contains("password")) {
        auto& copiedPassword = payload.at("password").get_ref<std::string&>();
        secureClear(copiedPassword);
    }
    return request;
}

Json runInjectorFor(DWORD session, const std::string& op, const std::string& password) {
    wchar_t exePath[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, exePath, MAX_PATH);
    SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE};
    HANDLE inRead = nullptr, inWrite = nullptr, outRead = nullptr, outWrite = nullptr;
    if (!CreatePipe(&inRead, &inWrite, &inheritable, 0) || !CreatePipe(&outRead, &outWrite, &inheritable, 0))
        return {{"ok", false}, {"error", "cannot create injector pipes"}};
    SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = inRead; startup.hStdOutput = outWrite; startup.hStdError = nullptr;
    PROCESS_INFORMATION process{};
    std::string command = "\"" + utf8(exePath) + "\" --inject";
    HANDLE token = nullptr;
    Json tokenResult = duplicateConsoleToken(session, token);
    if (tokenResult.value("ok", false) != true) {
        CloseHandle(inRead); CloseHandle(inWrite); CloseHandle(outRead); CloseHandle(outWrite);
        return tokenResult;
    }
    std::wstring commandLine = wide(command);
    const BOOL created = CreateProcessAsUserW(token, exePath, commandLine.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
    CloseHandle(token);
    CloseHandle(inRead); CloseHandle(outWrite);
    if (!created) {
        CloseHandle(inWrite); CloseHandle(outRead);
        return {{"ok", false}, {"error", "cannot start console-session injector"}};
    }
    std::string request = injectorRequestLine(op, password);
    const bool requestWritten = writeBytes(inWrite, request);
    SecureZeroMemory(request.data(), request.size());
    CloseHandle(inWrite);
    if (!requestWritten) {
        TerminateProcess(process.hProcess, 1);
        WaitForSingleObject(process.hProcess, 5000);
        CloseHandle(outRead);
        CloseHandle(process.hThread); CloseHandle(process.hProcess);
        return {{"ok", false}, {"error", "cannot send injector request"}};
    }
    const DWORD wait = WaitForSingleObject(process.hProcess, CONNECT_TIMEOUT_MS);
    std::string response;
    if (wait == WAIT_OBJECT_0) {
        char chunk[512]; DWORD read = 0;
        while (response.size() <= MAX_REQUEST && ReadFile(outRead, chunk, sizeof(chunk), &read, nullptr) && read) response.append(chunk, read);
    } else if (wait == WAIT_TIMEOUT) {
        TerminateProcess(process.hProcess, 1);
        response = "{\"ok\":false,\"error\":\"unlock-timeout\"}";
    } else response = "{\"ok\":false,\"error\":\"injector-wait-failed\"}";
    CloseHandle(outRead);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    Json result = {{"ok", false}, {"error", "injector produced no response"}};
    try { result = Json::parse(response); } catch (...) {}
    SecureZeroMemory(response.data(), response.size());
    return result;
}

Json handleRequest(DWORD session, const std::string& line) {
    Json request;
    try { request = Json::parse(line); } catch (...) { return {{"ok", false}, {"error", "invalid-json"}}; }
    const std::string op = request.value("op", std::string(""));
    if (op != "unlock" && request.contains("password") && request.at("password").is_string()) {
        auto& unexpectedPassword = request.at("password").get_ref<std::string&>();
        secureClear(unexpectedPassword);
    }
    if (op == "status") {
        const bool active = session != 0xFFFFFFFF && consoleUserPresent(session);
        return {{"ok", true}, {"available", true}, {"active", active}, {"locked", active && sessionLocked(session)}, {"session", session}};
    }
    if (op == "wake") {
        if (!sessionLocked(session)) return {{"ok", true}, {"woke", false}};
        return runInjectorFor(session, "wake", "");
    }
    if (op == "unlock") {
        if (!request.contains("password") || !request.at("password").is_string()) return {{"ok", false}, {"error", "invalid-password"}};
        auto& password = request["password"].get_ref<std::string&>();
        Json result;
        if (password.empty() || password.size() > 256) result = {{"ok", false}, {"error", "invalid-password"}};
        else if (!sessionLocked(session)) result = consoleUserPresent(session) ? Json{{"ok", true}, {"alreadyUnlocked", true}} : Json{{"ok", false}, {"error", "no-active-session"}};
        else if (!consoleUserPresent(session)) result = {{"ok", false}, {"error", "no-active-session"}};
        else result = runInjectorFor(session, "unlock", password);
        secureClear(password);
        return result;
    }
    return {{"ok", false}, {"error", "unknown-op"}};
}

// ── pipe server ─────────────────────────────────────────────────────────────

struct ServerState { HANDLE stopEvent = nullptr; };

void serveClient(HANDLE pipe) {
    std::string line;
    if (!readLine(pipe, line)) return;
    const DWORD session = consoleSession();
    const Json response = handleRequest(session, line);
    SecureZeroMemory(line.data(), line.size());
    writeLine(pipe, response, true);
}

int pipeServerLoop(const ServerState& state) {
    for (;;) {
        DWORD session = consoleSession();
        const std::wstring sddl = pipeSddl(session);
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, FALSE};
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
            if (WaitForSingleObject(state.stopEvent, 3000) == WAIT_OBJECT_0) break;
            continue;
        }
        attributes.lpSecurityDescriptor = descriptor;
        // FILE_FLAG_FIRST_PIPE_INSTANCE prevents a local squatter from owning
        // the name before the service does.
        HANDLE pipe = CreateNamedPipeW(PIPE_NAME, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE, 1, 8192, 8192, 0, &attributes);
        if (descriptor) LocalFree(descriptor);
        if (pipe == INVALID_HANDLE_VALUE) {
            if (WaitForSingleObject(state.stopEvent, 3000) == WAIT_OBJECT_0) break;
            continue;
        }
        OVERLAPPED overlapped{}; overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!overlapped.hEvent) { CloseHandle(pipe); continue; }
        const BOOL connected = ConnectNamedPipe(pipe, &overlapped);
        bool stop = false;
        if (!connected && GetLastError() == ERROR_IO_PENDING) {
            HANDLE waits[2] = {state.stopEvent, overlapped.hEvent};
            if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0) {
                CancelIo(pipe); stop = true;
            } else {
                DWORD ignored = 0;
                GetOverlappedResult(pipe, &overlapped, &ignored, FALSE);
            }
        } else if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) stop = WaitForSingleObject(state.stopEvent, 0) == WAIT_OBJECT_0;
        CloseHandle(overlapped.hEvent);
        if (!stop) serveClient(pipe);
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        if (stop) break;
    }
    return 0;
}

// ── service plumbing ────────────────────────────────────────────────────────

SERVICE_STATUS serviceStatus = {};
SERVICE_STATUS_HANDLE serviceStatusHandle = nullptr;
HANDLE g_stopEvent = nullptr;

void reportServiceStatus(DWORD state, DWORD exitCode = NO_ERROR) {
    serviceStatus.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    serviceStatus.dwCurrentState = state;
    serviceStatus.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
    serviceStatus.dwWin32ExitCode = exitCode;
    serviceStatus.dwWaitHint = state == SERVICE_START_PENDING ? 5000 : state == SERVICE_STOP_PENDING ? 15000 : 0;
    if (serviceStatusHandle) SetServiceStatus(serviceStatusHandle, &serviceStatus);
}

void WINAPI serviceControlHandler(DWORD control) {
    if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
        reportServiceStatus(SERVICE_STOP_PENDING);
        if (g_stopEvent) SetEvent(g_stopEvent);
    }
}

void WINAPI serviceMain(DWORD, LPWSTR*) {
    serviceStatusHandle = RegisterServiceCtrlHandlerW(SERVICE_NAME, serviceControlHandler);
    if (!serviceStatusHandle) return;
    reportServiceStatus(SERVICE_START_PENDING);
    g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_stopEvent) { reportServiceStatus(SERVICE_STOPPED, ERROR_OUTOFMEMORY); return; }
    ServerState state{g_stopEvent};
    std::thread server([&state] { pipeServerLoop(state); });
    reportServiceStatus(SERVICE_RUNNING);
    // Unblock within one client-read timeout even if a client is mid-request;
    // the pipe loop checks the event between clients.
    WaitForSingleObject(g_stopEvent, INFINITE);
    server.join();
    CloseHandle(g_stopEvent);
    g_stopEvent = nullptr;
    reportServiceStatus(SERVICE_STOPPED);
}

int printUsage() {
    std::cout << "usage: agentroam-remote-unlock.exe [--service|--console|--inject|--self-test]\n";
    return 1;
}
}

int main(int argc, char** argv) {
    const std::string mode = argc > 1 ? argv[1] : "";
    try {
        if (mode == "--self-test") {
            const DWORD session = consoleSession();
            const std::wstring sddl = pipeSddl(session);
            if (sddl.rfind(L"D:P(A;;GA;;;SY)", 0) != 0) throw std::runtime_error("pipe SDDL builder broken");
            sessionLocked(session);
            const Json roundTrip = Json::parse(injectorRequestLine("unlock", "p"));
            if (roundTrip.at("op").get<std::string>() != "unlock") throw std::runtime_error("json round-trip broken");
            std::cout << "unlock service self-test passed\n";
            return 0;
        }
        if (mode == "--inject") {
            std::string line;
            char chunk[512]; DWORD read = 0;
            while (line.size() <= MAX_REQUEST && ReadFile(GetStdHandle(STD_INPUT_HANDLE), chunk, sizeof(chunk), &read, nullptr) && read) {
                line.append(chunk, read);
                if (line.find('\n') != std::string::npos) break;
            }
            Json request = {{"op", "wake"}};
            try { request = Json::parse(line); } catch (...) {}
            SecureZeroMemory(line.data(), line.size());
            return runInjector(request);
        }
        if (mode == "--console") {
            ServerState state;
            state.stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
            std::wcout << L"listening on " << PIPE_NAME << L"\n";
            return pipeServerLoop(state);
        }
        if (mode == "--service" || mode.empty()) {
            const SERVICE_TABLE_ENTRYW table[] = {{const_cast<LPWSTR>(SERVICE_NAME), serviceMain}, {nullptr, nullptr}};
            if (!StartServiceCtrlDispatcherW(table)) {
                std::cerr << "not started by the service control manager\n";
                return 1;
            }
            return 0;
        }
        return printUsage();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
