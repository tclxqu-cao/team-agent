#include "remote.hpp"
#include <wtsapi32.h>

namespace remote {
std::wstring wide(const std::string& value) {
    if (value.empty()) return {};
    int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), int(value.size()), nullptr, 0);
    if (!size) throw std::runtime_error("Invalid UTF-8");
    std::wstring result(size, 0);
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), int(value.size()), result.data(), size);
    return result;
}
std::string utf8(const std::wstring& value) {
    int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), int(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(size, 0);
    WideCharToMultiByte(CP_UTF8, 0, value.data(), int(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}
bool desktopAvailable() {
    DWORD session = 0, bytes = 0; LPWSTR state = nullptr;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &session) || session == 0) return false;
    if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session, WTSConnectState, &state, &bytes)) return false;
    bool active = bytes >= sizeof(WTS_CONNECTSTATE_CLASS) && *reinterpret_cast<WTS_CONNECTSTATE_CLASS*>(state) == WTSActive;
    WTSFreeMemory(state);
    if (!active) return false;
    HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    if (!desktop) return false;
    wchar_t name[128] = {}; DWORD needed = 0;
    bool normal = GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &needed) && _wcsicmp(name, L"Default") == 0;
    CloseDesktop(desktop);
    return normal;
}
static void send(INPUT input) {
    if (SendInput(1, &input, sizeof(input)) != 1) throw std::runtime_error("Input unavailable; administrator windows and secure desktops are not supported");
}
static bool extended(WORD key) {
    return key == VK_RCONTROL || key == VK_RMENU || key == VK_LWIN || key == VK_RWIN ||
        (key >= VK_PRIOR && key <= VK_DOWN) || key == VK_INSERT || key == VK_DELETE || key == VK_DIVIDE;
}
void Input::key(WORD code, bool up) {
    INPUT event{}; event.type = INPUT_KEYBOARD; event.ki.wVk = code;
    event.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended(code) ? KEYEVENTF_EXTENDEDKEY : 0);
    send(event); if (up) heldKeys.erase(code); else heldKeys.insert(code);
}
void Input::button(const std::string& name, bool up) {
    INPUT event{}; event.type = INPUT_MOUSE;
    if (name == "left") event.mi.dwFlags = up ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_LEFTDOWN;
    else if (name == "right") event.mi.dwFlags = up ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_RIGHTDOWN;
    else if (name == "middle") event.mi.dwFlags = up ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_MIDDLEDOWN;
    else throw std::runtime_error("Unknown mouse button");
    send(event); if (up) heldButtons.erase(name); else heldButtons.insert(name);
}
void Input::release() {
    auto keys = heldKeys; auto buttons = heldButtons;
    for (auto code : keys) { try { key(code, true); } catch (...) {} }
    for (auto name : buttons) { try { button(name, true); } catch (...) {} }
    heldKeys.clear(); heldButtons.clear();
}
static WORD virtualKey(const std::string& code) {
    if (code.size() == 4 && code.substr(0, 3) == "Key" && code[3] >= 'A' && code[3] <= 'Z') return WORD(code[3]);
    if (code.size() == 6 && code.substr(0, 5) == "Digit" && code[5] >= '0' && code[5] <= '9') return WORD(code[5]);
    if (code.size() == 1 && std::isalnum(static_cast<unsigned char>(code[0]))) return WORD(std::toupper(code[0]));
    static const std::map<std::string, WORD> keys = {
        {"Enter",VK_RETURN},{"NumpadEnter",VK_RETURN},{"Escape",VK_ESCAPE},{"Backspace",VK_BACK},{"Tab",VK_TAB},
        {"Space",VK_SPACE},{" ",VK_SPACE},{"Delete",VK_DELETE},{"Insert",VK_INSERT},{"Home",VK_HOME},{"End",VK_END},
        {"PageUp",VK_PRIOR},{"PageDown",VK_NEXT},{"ArrowLeft",VK_LEFT},{"ArrowRight",VK_RIGHT},{"ArrowUp",VK_UP},{"ArrowDown",VK_DOWN},
        {"ControlLeft",VK_LCONTROL},{"ControlRight",VK_RCONTROL},{"Control",VK_LCONTROL},{"ShiftLeft",VK_LSHIFT},{"ShiftRight",VK_RSHIFT},{"Shift",VK_LSHIFT},
        {"AltLeft",VK_LMENU},{"AltRight",VK_RMENU},{"Alt",VK_LMENU},{"MetaLeft",VK_LWIN},{"MetaRight",VK_RWIN},{"Meta",VK_LWIN},
        {"PrintScreen",VK_SNAPSHOT},{"Pause",VK_PAUSE},{"NumLock",VK_NUMLOCK},{"ScrollLock",VK_SCROLL},{"ContextMenu",VK_APPS},
        {"Numpad0",VK_NUMPAD0},{"Numpad1",VK_NUMPAD1},{"Numpad2",VK_NUMPAD2},{"Numpad3",VK_NUMPAD3},{"Numpad4",VK_NUMPAD4},
        {"Numpad5",VK_NUMPAD5},{"Numpad6",VK_NUMPAD6},{"Numpad7",VK_NUMPAD7},{"Numpad8",VK_NUMPAD8},{"Numpad9",VK_NUMPAD9},
        {"NumpadAdd",VK_ADD},{"NumpadSubtract",VK_SUBTRACT},{"NumpadMultiply",VK_MULTIPLY},{"NumpadDivide",VK_DIVIDE},{"NumpadDecimal",VK_DECIMAL},
        {"CapsLock",VK_CAPITAL},{"Backquote",VK_OEM_3},{"Minus",VK_OEM_MINUS},{"Equal",VK_OEM_PLUS},{"BracketLeft",VK_OEM_4},
        {"BracketRight",VK_OEM_6},{"Backslash",VK_OEM_5},{"Semicolon",VK_OEM_1},{"Quote",VK_OEM_7},{"Comma",VK_OEM_COMMA},
        {"Period",VK_OEM_PERIOD},{"Slash",VK_OEM_2},{"F1",VK_F1},{"F2",VK_F2},{"F3",VK_F3},{"F4",VK_F4},{"F5",VK_F5},{"F6",VK_F6},
        {"F7",VK_F7},{"F8",VK_F8},{"F9",VK_F9},{"F10",VK_F10},{"F11",VK_F11},{"F12",VK_F12}
    };
    auto found = keys.find(code);
    if (found == keys.end()) throw std::runtime_error("Unsupported key code: " + code);
    return found->second;
}
Json Input::command(const Json& cmd) {
    if (!desktopAvailable()) { release(); throw std::runtime_error("Desktop paused: unlock Windows and dismiss UAC locally"); }
    const auto op = cmd.at("op").get<std::string>();
    if (op == "move" || op == "drag" || op == "down" || op == "up" || op == "click") {
        INPUT move{}; move.type = INPUT_MOUSE;
        move.mi.dx = absoluteCoordinate(cmd.at("x").get<double>(), GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN));
        move.mi.dy = absoluteCoordinate(cmd.at("y").get<double>(), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
        move.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        send(move);
        const auto name = cmd.value("button", std::string("left"));
        if (op == "down" || op == "up") button(name, op == "up");
        if (op == "click") for (int i = 0; i < std::clamp(cmd.value("click", 1), 1, 2); ++i) { button(name, false); button(name, true); }
    } else if (op == "wheel") {
        for (const auto& axis : {"deltaX", "deltaY"}) {
            double delta = cmd.value(axis, 0.0);
            if (!std::isfinite(delta)) throw std::runtime_error("Invalid wheel delta");
            if (!delta) continue;
            INPUT event{}; event.type = INPUT_MOUSE; bool vertical = std::string(axis) == "deltaY";
            event.mi.dwFlags = vertical ? MOUSEEVENTF_WHEEL : MOUSEEVENTF_HWHEEL;
            event.mi.mouseData = DWORD(LONG(std::clamp(delta * (vertical ? -1 : 1), -1200.0, 1200.0)));
            send(event);
        }
    } else if (op == "text") {
        auto text = wide(cmd.at("text").get<std::string>());
        if (text.size() > 4096) throw std::runtime_error("Text input too long");
        for (auto unit : text) {
            INPUT event{}; event.type = INPUT_KEYBOARD; event.ki.wScan = WORD(unit); event.ki.dwFlags = KEYEVENTF_UNICODE;
            send(event); event.ki.dwFlags |= KEYEVENTF_KEYUP; send(event);
        }
    } else if (op == "key") {
        auto action = cmd.value("action", std::string("press"));
        if (action != "down" && action != "up" && action != "press") throw std::runtime_error("Unknown key action");
        WORD code = virtualKey(cmd.at("code").get<std::string>());
        std::vector<WORD> temporary;
        const auto modifiers = cmd.value("modifiers", Json::array());
        if (!modifiers.is_array()) throw std::runtime_error("Invalid modifiers");
        for (const auto& modifier : modifiers) {
            const std::string name = modifier.get<std::string>();
            WORD vk = name == "Control" || name == "Ctrl" ? VK_LCONTROL : name == "Shift" ? VK_LSHIFT : name == "Alt" ? VK_LMENU : name == "Meta" ? VK_LWIN : 0;
            if (!vk) throw std::runtime_error("Unknown modifier");
            if (vk != code && !heldKeys.count(vk) && action != "up") { key(vk, false); temporary.push_back(vk); }
        }
        try { key(code, action == "up"); if (action == "press") key(code, true); }
        catch (...) { release(); throw; }
        for (auto vk : temporary) key(vk, true);
    } else throw std::runtime_error("Unknown input operation");
    return {{"ok",true}};
}
}
