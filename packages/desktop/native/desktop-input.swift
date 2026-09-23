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
    // Double-click semantics ride in as click:2/3 from the viewer.
    let clickState: Int64 = (op == "down" || op == "up") ? Int64((command["click"] as? NSNumber)?.intValue ?? 1) : 0
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
        if button == .left {
            activateAppUnder(x: x, y: y)
        }
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

// Plain discrete wheel events. Verified against macOS 26 apps: AppKit
// (TextEdit) AND SwiftUI (System Settings) scroll with phase-less pixel wheel
// events. Trackpad-style phase framing (Began/Changed/Ended) must NOT be used:
// SwiftUI panes ignore it entirely, so keep these events mouse-wheel shaped.
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

// Secure text fields require physical key events for ASCII, including capitals.
func textKeycode(_ ch: Character) -> (Int64, Bool)? {
    if let direct = charKeycodes[String(ch)] { return direct }
    if ch >= "A" && ch <= "Z", let lower = charKeycodes[String(ch).lowercased()] {
        return (lower.0, true)
    }
    return nil
}

func postText(_ command: [String: Any]) throws {
    guard let text = command["text"] as? String, !text.isEmpty else { throw HelperError("text command missing text") }
    let flags = modifierFlags(command["modifiers"] as? [String] ?? [])
    for ch in text {
        let resolved = textKeycode(ch)
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

// Model-driven GUI typing must be independent of the user's active input
// source. Keep `text` above for physical-key secure-entry compatibility, but
// send this path as literal Unicode so a Chinese IME cannot reinterpret ASCII
// as pinyin composition.
func postUnicodeText(_ command: [String: Any]) throws {
    guard let text = command["text"] as? String, !text.isEmpty else {
        throw HelperError("unicode text command missing text")
    }
    let utf16 = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
        throw HelperError("failed to create unicode text event")
    }
    down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

// Roles that accept text entry. Remote viewers use this to decide whether a
// tap should raise the soft keyboard.
let editableRoles: Set<String> = [
    "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
    "AXPasswordField", "AXSecureText",
]

// Interactive controls a tap should NOT re-raise the keyboard over.
let controlRoles: Set<String> = [
    "AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton",
    "AXTabGroup", "AXTab", "AXToolbar", "AXMenuBar", "AXMenuBarItem", "AXMenu",
    "AXMenuItem", "AXSlider", "AXIncrementor", "AXDisclosureTriangle",
    "AXLink", "AXImage", "AXSplitGroup", "AXScrollArea", "AXDockItem",
    "AXApplicationDockItem", "AXToggle", "AXStaticText", "AXHeading", "AXGroup",
]

// Clicking a background app's window via posted CGEvents lands the click but
// does not bring that app/window forward the way a physical click does. After
// a left press, activate the app under the cursor and raise its window so the
// click behaves like a physical one (ToDesk-style focus follows tap).
func activateAppUnder(x: CGFloat, y: CGFloat) {
    guard AXIsProcessTrusted() else { return }
    let systemWide = AXUIElementCreateSystemWide()
    var elementRef: AXUIElement?
    guard AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &elementRef) == .success,
          let element = elementRef else { return }
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    guard pid != 0, let app = NSRunningApplication(processIdentifier: pid) else { return }
    guard !app.isActive else { return }
    app.activate(options: [.activateIgnoringOtherApps])
    var windowRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &windowRef) == .success,
       let window = windowRef {
        AXUIElementPerformAction(window as! AXUIElement, kAXRaiseAction as CFString)
    }
    // Give the window server a beat to reorder before the click lands.
    usleep(80_000)
}

// Hit-tests the element under a click via the system-wide AX tree and reports
// what kind of thing it is, so the viewer can decide whether a tap should
// raise the soft keyboard:
//   editable:true  — text entry → raise
//   kind:"control" — buttons/menus/etc → leave the keyboard alone
//   editable:false — blank/background → raise (tap-to-type)
func hitTestEditable(x: CGFloat, y: CGFloat) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["editable": false] }
    let systemWide = AXUIElementCreateSystemWide()
    var elementRef: AXUIElement?
    guard AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &elementRef) == .success,
          let element = elementRef else {
        return ["editable": false]
    }
    var roleRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef) == .success,
          let role = roleRef as? String else {
        return ["editable": false]
    }
    if !editableRoles.contains(role) {
        if controlRoles.contains(role) {
            return ["editable": false, "kind": "control", "role": role]
        }
        return ["editable": false]
    }
    var bounds: [String: Double] = ["x": 0, "y": 0, "w": 0, "h": 0]
    var positionRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
       let value = positionRef, CFGetTypeID(value) == AXValueGetTypeID() {
        var point: CGPoint = .zero
        AXValueGetValue(value as! AXValue, .cgPoint, &point)
        bounds["x"] = Double(point.x)
        bounds["y"] = Double(point.y)
    }
    var sizeRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
       let value = sizeRef, CFGetTypeID(value) == AXValueGetTypeID() {
        var size: CGSize = .zero
        AXValueGetValue(value as! AXValue, .cgSize, &size)
        bounds["w"] = Double(size.width)
        bounds["h"] = Double(size.height)
    }
    return ["editable": true, "role": role, "bounds": bounds]
}

let axNodeLimit = 500
let axDepthLimit = 20
let axTextLimit = 40_000
let axSnapshotTimeout: TimeInterval = 1.5
var axRevisionSequence = 0
var currentAXRevision = ""
var currentAXRegistry: [String: AXUIElement] = [:]

struct AXCommandError: Error, CustomStringConvertible {
    let code: String
    let description: String
    init(_ code: String, _ description: String) {
        self.code = code
        self.description = description
    }
}

func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = axAttribute(element, name) else { return nil }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func axBool(_ element: AXUIElement, _ name: String) -> Bool? {
    guard let value = axAttribute(element, name) else { return nil }
    return (value as? NSNumber)?.boolValue
}

func axBounds(_ element: AXUIElement) -> [String: Double]? {
    var point = CGPoint.zero
    var size = CGSize.zero
    guard let position = axAttribute(element, kAXPositionAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(),
          AXValueGetValue(position as! AXValue, .cgPoint, &point),
          let sizeValue = axAttribute(element, kAXSizeAttribute),
          CFGetTypeID(sizeValue) == AXValueGetTypeID(),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return ["x": Double(point.x), "y": Double(point.y), "width": Double(size.width), "height": Double(size.height)]
}

func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
          let values = names as? [String] else { return [] }
    return values
}

func boundedAXText(_ value: String?, remaining: inout Int) -> String? {
    guard remaining > 0, let value, !value.isEmpty else { return nil }
    let bounded = String(value.prefix(remaining))
    remaining -= bounded.count
    return bounded
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = axAttribute(element, kAXChildrenAttribute),
          let children = value as? [AXUIElement] else { return [] }
    return children
}

func frontmostWindowOwnerPID() -> pid_t? {
    guard let windows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else { return nil }
    for window in windows {
        let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
        let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0
        let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
        if layer == 0, alpha > 0, pid > 0 { return pid_t(pid) }
    }
    return nil
}

func selectedAXRoot() throws -> (NSRunningApplication, AXUIElement, AXUIElement?) {
    // This helper blocks its main thread on stdin, so NSWorkspace's cached
    // frontmostApplication can go stale after the helper starts. WindowServer
    // ordering is process-global and stays current without an AppKit run loop.
    guard let pid = frontmostWindowOwnerPID() else {
        throw AXCommandError("action_not_supported", "no frontmost application window")
    }
    guard pid != 0, let application = NSRunningApplication(processIdentifier: pid) else {
        throw AXCommandError("action_not_supported", "frontmost application process is unavailable")
    }
    let appElement = AXUIElementCreateApplication(pid)
    let focusedWindow = axAttribute(appElement, kAXFocusedWindowAttribute) as! AXUIElement?
    let focusedElement = axAttribute(appElement, kAXFocusedUIElementAttribute) as! AXUIElement?
    let overlayRoles: Set<String> = ["AXSheet", "AXDialog", "AXMenu", "AXPopover"]
    let focusedRole = focusedElement.flatMap { axString($0, kAXRoleAttribute) }
    let root = focusedRole.map(overlayRoles.contains) == true
        ? focusedElement!
        : (focusedWindow ?? appElement)
    return (application, root, focusedWindow)
}

func accessibilitySnapshot() -> [String: Any] {
    axRevisionSequence += 1
    currentAXRevision = "ax_\(axRevisionSequence)"
    currentAXRegistry.removeAll(keepingCapacity: true)
    guard AXIsProcessTrusted() else {
        return ["ok": true, "status": "denied", "message": "macOS Accessibility permission is required"]
    }

    let startedAt = Date()
    do {
        let (application, root, focusedWindow) = try selectedAXRoot()
        var queue: [(element: AXUIElement, parentId: String?, depth: Int)] = [(root, nil, 0)]
        var visited = Set<CFHashCode>()
        var nodes: [[String: Any]] = []
        var remainingText = axTextLimit
        var partial = false

        while !queue.isEmpty {
            if Date().timeIntervalSince(startedAt) > axSnapshotTimeout {
                partial = true
                break
            }
            if nodes.count >= axNodeLimit {
                partial = true
                break
            }
            let entry = queue.removeFirst()
            let identity = CFHash(entry.element)
            if visited.contains(identity) { continue }
            visited.insert(identity)
            let id = "\(currentAXRevision):\(nodes.count + 1)"
            currentAXRegistry[id] = entry.element

            let role = axString(entry.element, kAXRoleAttribute) ?? "AXUnknown"
            let subrole = axString(entry.element, kAXSubroleAttribute)
            let secure = role.localizedCaseInsensitiveContains("secure")
                || (subrole?.localizedCaseInsensitiveContains("secure") ?? false)
            var node: [String: Any] = [
                "id": id,
                "role": role,
                "actions": axActionNames(entry.element),
            ]
            if let parentId = entry.parentId { node["parentId"] = parentId }
            if let value = boundedAXText(subrole, remaining: &remainingText) { node["subrole"] = value }
            if let value = boundedAXText(axString(entry.element, kAXTitleAttribute), remaining: &remainingText) { node["name"] = value }
            if !secure, let value = boundedAXText(axString(entry.element, kAXValueAttribute), remaining: &remainingText) { node["value"] = value }
            if let value = boundedAXText(axString(entry.element, kAXDescriptionAttribute), remaining: &remainingText) { node["description"] = value }
            if let value = boundedAXText(axString(entry.element, kAXIdentifierAttribute), remaining: &remainingText) { node["identifier"] = value }
            if let value = axBool(entry.element, kAXEnabledAttribute) { node["enabled"] = value }
            if let value = axBool(entry.element, kAXFocusedAttribute) { node["focused"] = value }
            if let value = axBool(entry.element, kAXSelectedAttribute) { node["selected"] = value }
            if let value = axBounds(entry.element) { node["bounds"] = value }
            nodes.append(node)

            let children = axChildren(entry.element)
            if entry.depth >= axDepthLimit {
                if !children.isEmpty { partial = true }
                continue
            }
            for child in children {
                queue.append((child, id, entry.depth + 1))
            }
            if remainingText <= 0 { partial = true }
        }

        var observation: [String: Any] = [
            "source": "accessibility",
            "revision": currentAXRevision,
            "coverage": partial ? "partial" : "complete",
            "app": [
                "name": application.localizedName ?? "",
                "bundleId": application.bundleIdentifier ?? "",
                "pid": Int(application.processIdentifier),
            ],
            "nodes": nodes,
            "truncated": partial,
            "elapsedMs": Int(Date().timeIntervalSince(startedAt) * 1000),
        ]
        if let focusedWindow {
            var window: [String: Any] = [:]
            if let title = axString(focusedWindow, kAXTitleAttribute) { window["title"] = title }
            if let bounds = axBounds(focusedWindow) { window["bounds"] = bounds }
            if !window.isEmpty { observation["window"] = window }
        }
        return ["ok": true, "status": "ok", "observation": observation]
    } catch let error as AXCommandError {
        return ["ok": true, "status": "unavailable", "message": error.description]
    } catch {
        return ["ok": true, "status": "unavailable", "message": String(describing: error)]
    }
}

func performAccessibilityAction(_ command: [String: Any]) throws {
    guard AXIsProcessTrusted() else {
        throw AXCommandError("accessibility_denied", "macOS Accessibility permission is required")
    }
    guard let revision = command["revision"] as? String,
          revision == currentAXRevision else {
        throw AXCommandError("stale_observation", "Accessibility observation is stale; observe again")
    }
    guard let nodeId = command["nodeId"] as? String,
          let element = currentAXRegistry[nodeId] else {
        throw AXCommandError("node_not_found", "Accessibility node no longer exists; observe again")
    }
    let action = command["action"] as? String ?? ""
    switch action {
    case "press":
        guard axActionNames(element).contains(kAXPressAction) else {
            throw AXCommandError("action_not_supported", "Accessibility node does not support press")
        }
        let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard result == .success else {
            throw AXCommandError("action_not_supported", "AXPress failed with code \(result.rawValue)")
        }
    case "focus":
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        if let app = NSRunningApplication(processIdentifier: pid) {
            app.activate(options: [.activateIgnoringOtherApps])
        }
        let result = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard result == .success else {
            throw AXCommandError("action_not_supported", "AX focus failed with code \(result.rawValue)")
        }
    default:
        throw AXCommandError("action_not_supported", "unsupported Accessibility action \(action)")
    }
}

func setAccessibilityText(_ command: [String: Any]) throws {
    guard AXIsProcessTrusted() else {
        throw AXCommandError("accessibility_denied", "macOS Accessibility permission is required")
    }
    guard let revision = command["revision"] as? String,
          revision == currentAXRevision else {
        throw AXCommandError("stale_observation", "Accessibility observation is stale; observe again")
    }
    guard let nodeId = command["nodeId"] as? String,
          let element = currentAXRegistry[nodeId] else {
        throw AXCommandError("node_not_found", "Accessibility node no longer exists; observe again")
    }
    guard let text = command["text"] as? String else {
        throw AXCommandError("invalid_request", "Accessibility text action is missing text")
    }
    let replace = (command["replace"] as? Bool) == true
    let attribute = replace ? kAXValueAttribute : kAXSelectedTextAttribute
    var settable = DarwinBoolean(false)
    let settableResult = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
    guard settableResult == .success, settable.boolValue else {
        throw AXCommandError("action_not_supported", "Accessibility node does not support exact text input")
    }
    let result = AXUIElementSetAttributeValue(element, attribute as CFString, text as CFString)
    guard result == .success else {
        throw AXCommandError("action_not_supported", "AX text input failed with code \(result.rawValue)")
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
        case "ax_snapshot":
            return reply(id, accessibilitySnapshot())
        case "ax_action":
            try performAccessibilityAction(command)
            return reply(id, ["ok": true])
        case "ax_text":
            try setAccessibilityText(command)
            return reply(id, ["ok": true])
        case "move", "down", "up", "drag":
            try postMouse(command)
            // The click release also reports what the user tapped on so the
            // remote viewer can raise/lower the soft keyboard accordingly.
            if op == "up", let xNumber = command["x"] as? NSNumber, let yNumber = command["y"] as? NSNumber {
                var payload = hitTestEditable(x: CGFloat(xNumber.doubleValue), y: CGFloat(yNumber.doubleValue))
                payload["ok"] = true
                return reply(id, payload)
            }
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
        case "unicode_text":
            try postUnicodeText(command)
            return reply(id, ["ok": true])
        default:
            return replyError(id, "unsupported op \(op)")
        }
    } catch let error as AXCommandError {
        return replyError(id, error.description, code: error.code)
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
    replyError(id, message, code: nil)
}

func replyError(_ id: Int?, _ message: String, code: String?) -> String {
    var payload: [String: Any] = ["id": id as Any, "ok": false, "error": message]
    if let code { payload["code"] = code }
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return "{\"ok\":false,\"error\":\"\(message)\"}" }
    return String(data: data, encoding: .utf8) ?? "{\"ok\":false,\"error\":\"\(message)\"}"
}

// Dispatch-driven stdin loop so the process exits cleanly on EOF (a blocking
// readLine() loop would linger after the gateway closes the pipe).
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
var inputBuffer = Data()

func processInputData() {
    while let newline = inputBuffer.firstIndex(of: UInt8(ascii: "\n")) {
        let line = Data(inputBuffer[inputBuffer.startIndex..<newline])
        inputBuffer.removeSubrange(inputBuffer.startIndex...newline)
        guard let text = String(data: line, encoding: .utf8)?.trimmingCharacters(in: .whitespaces),
              !text.isEmpty,
              let response = handle(text) else { continue }
        FileHandle.standardOutput.write(Data((response + "\n").utf8))
    }
}

stdinSource.setEventHandler { [weak stdinSource] in
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty {
        stdinSource?.cancel()
        return
    }
    inputBuffer.append(chunk)
    processInputData()
}
stdinSource.setCancelHandler {
    // dispatchMain() never returns; exit explicitly once stdin closes.
    exit(0)
}
stdinSource.resume()
dispatchMain()
