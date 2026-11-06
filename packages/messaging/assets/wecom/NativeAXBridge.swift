import Foundation
import AppKit
import ApplicationServices
import Darwin

struct BridgeFailure: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) throws -> Never { throw BridgeFailure(code: code, message: message) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String { attr(element, name) as? String ?? "" }
func children(_ element: AXUIElement, _ name: String = kAXChildrenAttribute) -> [AXUIElement] {
    attr(element, name) as? [AXUIElement] ?? []
}
func settable(_ element: AXUIElement, _ name: String) -> Bool {
    var value = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, name as CFString, &value) == .success && value.boolValue
}
func frame(_ element: AXUIElement) -> CGRect? {
    guard let p = attr(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = attr(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func flat(_ root: AXUIElement, maxDepth: Int = 20) -> [(AXUIElement, [Int])] {
    var result: [(AXUIElement, [Int])] = []; var queue: [(AXUIElement, [Int])] = [(root, [])]; var next = 0
    while next < queue.count && result.count < 3500 {
        let item = queue[next]; next += 1; result.append(item)
        if item.1.count < maxDepth { queue.append(contentsOf: children(item.0).enumerated().map { ($0.element, item.1 + [$0.offset]) }) }
    }
    return result
}
func snapshot(_ app: AXUIElement, compact: Bool = false) -> [[String: Any]] {
    children(app, kAXWindowsAttribute).enumerated().map { index, window in
        let nodes: [[String: Any]] = flat(window, maxDepth: compact ? 7 : 20).map { element, path in
            var item: [String: Any] = ["path": path, "role": text(element, kAXRoleAttribute),
                "title": text(element, kAXTitleAttribute), "value": text(element, kAXValueAttribute),
                "description": text(element, kAXDescriptionAttribute), "valueSettable": settable(element, kAXValueAttribute),
                "selectedSettable": settable(element, kAXSelectedAttribute),
                "selected": attr(element, kAXSelectedAttribute) as? Bool ?? false,
                "enabled": attr(element, kAXEnabledAttribute) as? Bool ?? true]
            if let box = frame(element) { item["frame"] = [box.minX, box.minY, box.width, box.height] }
            var actions: CFArray?
            if AXUIElementCopyActionNames(element, &actions) == .success { item["actions"] = actions as? [String] ?? [] }
            return item
        }
        return ["index": index, "title": text(window, kAXTitleAttribute), "subrole": text(window, kAXSubroleAttribute), "nodes": nodes]
    }
}
func resolve(_ root: AXUIElement, _ path: [Int]) throws -> AXUIElement {
    var current = root
    for index in path {
        let values = children(current)
        guard values.indices.contains(index) else { try fail("STALE_NODE", "Native control changed") }
        current = values[index]
    }
    return current
}
func rowTitle(_ row: AXUIElement) -> String {
    guard let box = frame(row) else { return "" }
    return flat(row, maxDepth: 3).first { element, _ in
        guard text(element, kAXRoleAttribute) == kAXStaticTextRole, let label = frame(element) else { return false }
        return !text(element, kAXValueAttribute).isEmpty && label.minY < box.minY + 30 && label.minX > box.minX + 30
    }.map { text($0.0, kAXValueAttribute) } ?? ""
}
func validateChat(_ window: AXUIElement, _ input: AXUIElement, _ request: [String: Any]) throws {
    guard let expected = request["chatTitle"] as? String, !expected.isEmpty,
          let path = request["headerPath"] as? [Int], (2...4).contains(path.count),
          let inputPath = request["path"] as? [Int], Array(path.dropLast()) == Array(inputPath.prefix(path.count - 1)),
          let inputBox = frame(input) else { try fail("RECIPIENT_UNVERIFIED", "发送前必须核对聊天标题") }
    let header = try resolve(window, path)
    guard [kAXTextFieldRole, kAXStaticTextRole].contains(text(header, kAXRoleAttribute)),
          text(header, kAXValueAttribute) == expected, let box = frame(header),
          box.minX >= inputBox.minX, box.minY < inputBox.minY else {
        try fail("RECIPIENT_CHANGED", "聊天标题已变化，未发送")
    }
    let selected = flat(window, maxDepth: 5).filter { element, _ in
        text(element, kAXRoleAttribute) == kAXRowRole && (attr(element, kAXSelectedAttribute) as? Bool ?? false)
            && (frame(element)?.minX ?? inputBox.minX) < inputBox.minX
    }
    guard selected.count == 1, rowTitle(selected[0].0) == expected else {
        try fail("RECIPIENT_CHANGED", "所选会话与聊天标题不一致，未发送")
    }
}
func ensureFront(_ application: NSRunningApplication, _ window: AXUIElement) throws {
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    application.activate(options: [.activateAllWindows])
    let deadline = Date().addingTimeInterval(2)
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != application.processIdentifier && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else {
        try fail("FOCUS_CHANGED", "WeCom could not become active")
    }
}
func key(_ pid: pid_t, _ code: CGKeyCode, command: Bool = false) throws {
    guard CGPreflightPostEventAccess() else { try fail("EVENT_PERMISSION_REQUIRED", "macOS event posting permission is required") }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { try fail("FOCUS_CHANGED", "Active application changed") }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        try fail("EVENT_FAILED", "Could not construct keyboard event")
    }
    if command { down.flags = .maskCommand; up.flags = .maskCommand }
    down.postToPid(pid); up.postToPid(pid)
    RunLoop.current.run(until: Date().addingTimeInterval(0.2))
}
func click(_ element: AXUIElement, _ application: NSRunningApplication, _ window: AXUIElement) throws {
    try ensureFront(application, window)
    guard let box = frame(element), box.width > 0, box.height > 0 else { try fail("CONTROL_HIDDEN", "Native control is not visible") }
    guard CGPreflightPostEventAccess() else { try fail("EVENT_PERMISSION_REQUIRED", "macOS event posting permission is required") }
    let point = CGPoint(x: box.midX, y: box.midY)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        try fail("EVENT_FAILED", "Could not construct mouse event")
    }
    down.postToPid(application.processIdentifier); up.postToPid(application.processIdentifier)
    RunLoop.current.run(until: Date().addingTimeInterval(0.2))
}
func paste(_ value: String, _ element: AXUIElement, _ application: NSRunningApplication, _ window: AXUIElement) throws {
    try ensureFront(application, window)
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard let focused = attr(AXUIElementCreateApplication(application.processIdentifier), kAXFocusedUIElementAttribute), CFEqual(focused, element) else {
        try fail("INPUT_NOT_FOCUSED", "Requested input did not gain focus")
    }
    let board = NSPasteboard.general
    let saved = (board.pasteboardItems ?? []).map { item -> [NSPasteboard.PasteboardType: Data] in
        var values: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types { if let data = item.data(forType: type) { values[type] = data } }; return values
    }
    board.clearContents(); board.setString(value, forType: .string); let generation = board.changeCount
    defer {
        if board.changeCount == generation {
            board.clearContents()
            let items = saved.map { values -> NSPasteboardItem in
                let item = NSPasteboardItem(); for (type, data) in values { item.setData(data, forType: type) }; return item
            }
            if !items.isEmpty { board.writeObjects(items) }
        }
    }
    try key(application.processIdentifier, 9, command: true)
}
func execute(_ request: [String: Any]) throws -> [String: Any] {
    guard AXIsProcessTrusted() else { try fail("ACCESSIBILITY_REQUIRED", "请在 macOS 无障碍权限中启用 AgentRoam 企微发送桥") }
    guard let pid = request["pid"] as? Int32, let application = NSRunningApplication(processIdentifier: pid),
          !application.isTerminated, application.executableURL?.path == "/Applications/企业微信.app/Contents/MacOS/企业微信" else {
        try fail("CLIENT_MISSING", "未匹配指定的原版企微进程")
    }
    let app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 2)
    let operation = request["op"] as? String ?? "inspect"
    if operation == "inspect" { return ["status": "ready", "version": 2, "pid": pid, "accessibility": true,
        "postEvents": CGPreflightPostEventAccess(), "windows": snapshot(app, compact: request["compact"] as? Bool ?? false)] }
    let windows = children(app, kAXWindowsAttribute)
    guard let index = request["window"] as? Int, windows.indices.contains(index) else { try fail("WINDOW_MISSING", "Requested WeCom window is unavailable") }
    let window = windows[index]
    guard text(window, kAXTitleAttribute) == request["windowTitle"] as? String else { try fail("STALE_WINDOW", "WeCom window identity changed") }
    if operation == "activate" { try ensureFront(application, window); return ["status": "ready"] }
    if operation == "selectConversation" {
        guard let expected = request["chatTitle"] as? String, !expected.isEmpty else { try fail("INVALID_REQUEST", "Conversation title is required") }
        let matches = flat(window, maxDepth: 5).filter { text($0.0, kAXRoleAttribute) == kAXRowRole && rowTitle($0.0) == expected }
        guard matches.count == 1 else { try fail("RECIPIENT_AMBIGUOUS", "未唯一匹配会话名称，请先在企微打开目标会话") }
        try ensureFront(application, window)
        let row = matches[0].0
        guard rowTitle(row) == expected, settable(row, kAXSelectedAttribute),
              AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success else {
            try fail("SELECT_FAILED", "目标会话已变化或无法选择")
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        return ["status": "ready"]
    }
    guard let path = request["path"] as? [Int], let role = request["role"] as? String else { try fail("INVALID_REQUEST", "A control path and role are required") }
    let element = try resolve(window, path)
    guard text(element, kAXRoleAttribute) == role else { try fail("STALE_NODE", "Native control role changed") }
    if let expected = request["expectedValue"] as? String, text(element, kAXValueAttribute) != expected { try fail("STALE_NODE", "Native control content changed") }
    switch operation {
    case "select":
        if let expected = request["expectedText"] as? String, rowTitle(element) != expected { try fail("STALE_NODE", "会话列表已重排") }
        guard role == kAXRowRole, settable(element, kAXSelectedAttribute),
              AXUIElementSetAttributeValue(element, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success else {
            try fail("SELECT_FAILED", "Native row could not be selected")
        }
    case "click": try click(element, application, window)
    case "paste":
        guard [kAXTextAreaRole, kAXTextFieldRole].contains(role), settable(element, kAXValueAttribute),
              let value = request["text"] as? String, value.utf8.count <= 20_000,
              text(element, kAXValueAttribute).isEmpty else { try fail("DRAFT_PRESENT", "目标输入框已有草稿或内容无效，未覆盖") }
        try ensureFront(application, window)
        try validateChat(window, element, request)
        try paste(value, element, application, window)
        guard text(element, kAXValueAttribute) == value else { try fail("PASTE_FAILED", "正文未完整进入目标输入框，未发送") }
    case "submit":
        guard role == kAXTextAreaRole, let body = request["text"] as? String, !body.isEmpty,
              text(element, kAXValueAttribute) == body, let header = request["chatTitle"] as? String, !header.isEmpty else {
            try fail("DRAFT_CHANGED", "正文与已准备草稿不一致")
        }
        _ = header
        try validateChat(window, element, request)
        try ensureFront(application, window)
        _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard let focused = attr(app, kAXFocusedUIElementAttribute), CFEqual(focused, element) else { try fail("INPUT_NOT_FOCUSED", "发送输入框未获得焦点") }
        try validateChat(window, element, request)
        guard text(element, kAXValueAttribute) == body else { try fail("DRAFT_CHANGED", "发送前正文发生变化") }
        try key(pid, 36)
        return ["status": "submitted", "requiresVerification": true]
    default: try fail("INVALID_OPERATION", "Unsupported local bridge operation")
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.15)); return ["status": "ready"]
}

let args = CommandLine.arguments
func argument(_ key: String) -> String? {
    guard let index = args.firstIndex(of: key), index + 1 < args.count else { return nil }; return args[index + 1]
}
let application = NSApplication.shared; application.setActivationPolicy(.accessory)
if args.contains("--request-permission") {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    exit(0)
}
var result: [String: Any]
do {
    let data: Data
    if let input = argument("--request") {
        let attrs = try FileManager.default.attributesOfItem(atPath: input)
        guard (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0 else { try fail("INPUT_PERMISSIONS", "Bridge input must be private to the current user") }
        data = try Data(contentsOf: URL(fileURLWithPath: input))
    } else { data = FileHandle.standardInput.readDataToEndOfFile() }
    guard data.count <= 65_536, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("INVALID_REQUEST", "Expected a bounded JSON object") }
    result = try execute(request)
} catch let error as BridgeFailure { result = ["status": "blocked", "code": error.code, "error": error.message]
} catch { result = ["status": "blocked", "code": "BRIDGE_ERROR", "error": error.localizedDescription] }
let output = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
if let path = argument("--response") {
    try! output.write(to: URL(fileURLWithPath: path), options: [.atomic])
    try! FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
} else { FileHandle.standardOutput.write(output); FileHandle.standardOutput.write(Data([10])) }
