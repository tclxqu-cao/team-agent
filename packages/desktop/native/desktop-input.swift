// desktop-input — JSON-lines helper that injects global mouse/keyboard events on macOS.
// Requests on stdin, one JSON object per line; replies on stdout, one JSON object per line.
// Requires Accessibility (AX) trust for event injection; `check` reports AXIsProcessTrusted.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

let keycodes: [String: Int64] = [
    "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05,
    "KeyZ": 0x06, "KeyX": 0x07, "KeyC": 0x08, "KeyV": 0x09, "KeyB": 0x0B, "KeyQ": 0x0C,
    "KeyW": 0x0D, "KeyE": 0x0E, "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11,
    "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16,
    "Digit5": 0x17, "Digit9": 0x19, "Digit7": 0x1A, "Digit8": 0x1C, "Digit0": 0x1D,
    "KeyO": 0x1F, "KeyU": 0x20, "KeyI": 0x22, "KeyP": 0x23, "KeyL": 0x25, "KeyJ": 0x26,
    "KeyK": 0x28, "KeyN": 0x2D, "KeyM": 0x2E,
    "Minus": 0x1B, "Equal": 0x18, "BracketLeft": 0x21, "BracketRight": 0x1E,
    "Semicolon": 0x29, "Quote": 0x27, "Backslash": 0x2A, "Comma": 0x2B, "Slash": 0x2C,
    "Period": 0x2F, "Backquote": 0x32,
    "Space": 0x31, "Enter": 0x24, "Tab": 0x30, "Escape": 0x35, "Backspace": 0x33,
    "Delete": 0x75, "ArrowUp": 0x7E, "ArrowDown": 0x7D, "ArrowLeft": 0x7B, "ArrowRight": 0x7C,
    "Home": 0x73, "End": 0x77, "PageUp": 0x74, "PageDown": 0x79,
    "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61,
    "F7": 0x62, "F8": 0x64, "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,
]

func modifierFlags(_ names: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for name in names {
        switch name {
        case "Shift": flags.insert(.maskShift)
        case "Control": flags.insert(.maskControl)
        case "Alt": flags.insert(.maskAlternate)
        case "Meta": flags.insert(.maskCommand)
        default: break
        }
    }
    return flags
}

func mouseButton(_ name: String?) -> CGMouseButton {
    switch name {
    case "right": return .right
    case "middle": return .center
    default: return .left
    }
}

func postMouse(_ command: [String: Any]) throws {
    guard let op = command["op"] as? String else { throw HelperError("mouse command missing op") }
    let x = CGFloat((command["x"] as? NSNumber)?.doubleValue ?? 0)
    let y = CGFloat((command["y"] as? NSNumber)?.doubleValue ?? 0)
    let point = CGPoint(x: x, y: y)
    let button = mouseButton(command["button"] as? String)

    let type: CGEventType
    let eventButton: CGMouseButton
    let clickState: Int64 = (op == "down" || op == "up") ? 1 : 0
    switch op {
    case "move":
        type = .mouseMoved
        eventButton = .left
    case "drag":
        type = .leftMouseDragged
        eventButton = .left
    case "down":
        switch button {
        case .left: type = .leftMouseDown
        case .right: type = .rightMouseDown
        case .center: type = .otherMouseDown
        @unknown default: type = .leftMouseDown
        }
        eventButton = button
    case "up":
        switch button {
        case .left: type = .leftMouseUp
        case .right: type = .rightMouseUp
        case .center: type = .otherMouseUp
        @unknown default: type = .leftMouseUp
        }
        eventButton = button
    default:
        throw HelperError("unsupported mouse op \(op)")
    }
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: eventButton) else {
        throw HelperError("failed to create mouse event")
    }
    if clickState > 0 {
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
    }
    event.post(tap: .cghidEventTap)
}

func postWheel(_ command: [String: Any]) throws {
    let deltaX = (command["deltaX"] as? NSNumber)?.doubleValue ?? 0
    let deltaY = (command["deltaY"] as? NSNumber)?.doubleValue ?? 0
    // DOM wheel deltas are positive when scrolling down/right; CG pixel scroll is inverted.
    let wheelCount: UInt32 = deltaX != 0 ? 2 : 1
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: wheelCount, wheel1: Int32(clamping: -Int(deltaY)), wheel2: Int32(clamping: -Int(deltaX)), wheel3: 0) else {
        throw HelperError("failed to create scroll event")
    }
    event.post(tap: .cghidEventTap)
}

func postKey(_ command: [String: Any]) throws {
    let down = (command["action"] as? String) != "up"
    let code = command["code"] as? String ?? ""
    let fallbackKey = command["key"] as? String ?? ""
    let flags = modifierFlags(command["modifiers"] as? [String] ?? [])

    if let keycode = keycodes[code] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(clamping: keycode), keyDown: down) else {
            throw HelperError("failed to create keyboard event")
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
        return
    }
    // Unknown keycode: fall back to unicode text injection when a single character is available.
    if down, fallbackKey.count == 1 {
        try postText(["text": fallbackKey, "modifiers": command["modifiers"] as? [String] ?? []])
    }
}

// Character → (virtualKey, requiresShift) on the US (ABC) layout. Secure text
// entry (loginwindow password box) drops keyboardSetUnicodeString events, so
// typed text must go out as real keycode events to unlock a locked Mac.
let charKeycodes: [String: (Int64, Bool)] = [
    "a": (0x00, false), "s": (0x01, false), "d": (0x02, false), "f": (0x03, false),
    "h": (0x04, false), "g": (0x05, false), "z": (0x06, false), "x": (0x07, false),
    "c": (0x08, false), "v": (0x09, false), "b": (0x0B, false), "q": (0x0C, false),
    "w": (0x0D, false), "e": (0x0E, false), "r": (0x0F, false), "y": (0x10, false),
    "t": (0x11, false), "o": (0x1F, false), "u": (0x20, false), "i": (0x22, false),
    "p": (0x23, false), "l": (0x25, false), "j": (0x26, false), "k": (0x28, false),
    "n": (0x2D, false), "m": (0x2E, false),
    "1": (0x12, false), "2": (0x13, false), "3": (0x14, false), "4": (0x15, false),
    "5": (0x17, false), "6": (0x16, false), "7": (0x1A, false), "8": (0x1C, false),
    "9": (0x19, false), "0": (0x1D, false),
    "-": (0x1B, false), "=": (0x18, false), "[": (0x21, false), "]": (0x1E, false),
    "\\": (0x2A, false), ";": (0x29, false), "'": (0x27, false), ",": (0x2B, false),
    ".": (0x2F, false), "/": (0x2C, false), "`": (0x32, false), " ": (0x31, false),
    "\n": (0x24, false), "\t": (0x30, false),
    "!": (0x12, true), "@": (0x13, true), "#": (0x14, true), "$": (0x15, true),
    "%": (0x17, true), "^": (0x16, true), "&": (0x1A, true), "*": (0x1C, true),
    "(": (0x19, true), ")": (0x1D, true),
    "_": (0x1B, true), "+": (0x18, true), "{": (0x21, true), "}": (0x1E, true),
    "|": (0x2A, true), ":": (0x29, true), "\"": (0x27, true), "<": (0x2B, true),
    ">": (0x2F, true), "?": (0x2C, true), "~": (0x32, true),
]

func postText(_ command: [String: Any]) throws {
    guard let text = command["text"] as? String, !text.isEmpty else { throw HelperError("text command missing text") }
    let flags = modifierFlags(command["modifiers"] as? [String] ?? [])
    for ch in text {
        // Accented letters outside the ASCII table (é, ü, …) map through their
        // uppercase base letter with shift; everything else keeps unicode injection.
        let resolved: (Int64, Bool)?
        if let direct = charKeycodes[String(ch)] {
            resolved = direct
        } else if ch.isLetter, String(ch) != String(ch).uppercased(),
                  let upperKey = charKeycodes[String(ch).uppercased()] {
            resolved = (upperKey.0, true)
        } else {
            resolved = nil
        }
        if let (virtualKey, requiresShift) = resolved {
            var eventFlags = flags
            if requiresShift { eventFlags.insert(.maskShift) }
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(clamping: virtualKey), keyDown: down) else {
                    throw HelperError("failed to create keyboard event")
                }
                event.flags = eventFlags
                event.post(tap: .cghidEventTap)
            }
        } else {
            // Non-ASCII (CJK etc.) has no US-layout keycode; unicode-string
            // injection still works in ordinary (non-secure) text fields.
            let utf16 = Array(String(ch).utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else {
                    throw HelperError("failed to create text event")
                }
                event.flags = flags
                event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                event.post(tap: .cghidEventTap)
            }
        }
    }
}

struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func handle(_ line: String) -> String? {
    guard let data = line.data(using: .utf8) else { return replyError(nil, "invalid utf8") }
    guard let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return replyError(nil, "invalid json")
    }
    let id = (command["id"] as? NSNumber)?.intValue
    let op = command["op"] as? String ?? ""
    do {
        switch op {
        case "check":
            let trusted = AXIsProcessTrusted()
            return reply(id, ["ok": true, "trusted": trusted])
        case "move", "down", "up", "drag":
            try postMouse(command)
            return reply(id, ["ok": true])
        case "wheel":
            try postWheel(command)
            return reply(id, ["ok": true])
        case "key":
            try postKey(command)
            return reply(id, ["ok": true])
        case "text":
            try postText(command)
            return reply(id, ["ok": true])
        default:
            return replyError(id, "unsupported op \(op)")
        }
    } catch {
        return replyError(id, String(describing: error))
    }
}

func reply(_ id: Int?, _ payload: [String: Any]) -> String {
    var payload = payload
    if let id { payload["id"] = id }
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{\"ok\":false,\"error\":\"encode failed\"}" }
    return String(data: data, encoding: .utf8) ?? "{\"ok\":false,\"error\":\"encode failed\"}"
}

func replyError(_ id: Int?, _ message: String) -> String {
    let payload: [String: Any] = ["id": id as Any, "ok": false, "error": message]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{\"ok\":false,\"error\":\"\(message)\"}" }
    return String(data: data, encoding: .utf8) ?? "{\"ok\":false,\"error\":\"\(message)\"}"
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    if let response = handle(trimmed) {
        FileHandle.standardOutput.write(Data((response + "\n").utf8))
    }
}
