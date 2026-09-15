// This suffix is built with the existing input helper's functions, not its stdin loop.
import ScreenCaptureKit
import Darwin
import CoreImage
import CoreMedia
import IOKit.pwr_mgt

if CommandLine.arguments.contains("--config") || CommandLine.arguments.contains("--diagnose") || CommandLine.arguments.contains("--request-permissions") {
    runStandaloneService()
    exit(0)
}

// Assertions are owned by this helper and released by macOS when it exits.
var displayAssertion = IOPMAssertionID(0)
var displayHeld = false
func wakeRemoteDisplay() {
    var activity = IOPMAssertionID(0)
    IOPMAssertionDeclareUserActivity("AgentRoam remote input" as CFString, kIOPMUserActiveLocal, &activity)
}
func holdRemoteDisplay() {
    guard !displayHeld else { return }
    wakeRemoteDisplay()
    displayHeld = IOPMAssertionCreateWithName(kIOPMAssertionTypeNoDisplaySleep as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn), "AgentRoam desktop sharing" as CFString,
        &displayAssertion) == kIOReturnSuccess
}
if CommandLine.arguments.contains("--wake-self-test") {
    holdRemoteDisplay()
    precondition(displayHeld, "Unable to hold display awake")
    precondition(IOPMAssertionRelease(displayAssertion) == kIOReturnSuccess)
    print("display wake assertion created and released")
    exit(0)
}
if CommandLine.arguments.contains("--input-self-test") {
    for scalar in 65...90 {
        let upper = Character(String(UnicodeScalar(scalar)!))
        let lower = Character(String(UnicodeScalar(scalar + 32)!))
        precondition(textKeycode(upper)?.0 == textKeycode(lower)?.0)
        precondition(textKeycode(upper)?.1 == true)
        precondition(textKeycode(lower)?.1 == false)
    }
    precondition(textKeycode("1")?.0 == 0x12)
    precondition(textKeycode("!")?.1 == true)
    precondition(textKeycode("中") == nil)
    print("input mapping self-test passed")
    exit(0)
}

if CommandLine.arguments.contains("--quality-self-test") {
    precondition(RemoteVideoQuality.hd.dimensions(width: 3840, height: 2160) == (2560, 1440))
    precondition(RemoteVideoQuality.smooth.dimensions(width: 1440, height: 2560) == (720, 1280))
    precondition(RemoteVideoQuality.original.dimensions(width: 3024, height: 1964) == (3024, 1964))
    precondition(RemoteVideoQuality.hd.dimensions(width: 1024, height: 768) == (1024, 768))
    precondition(RemoteVideoQuality(rawValue: "invalid") == nil)
    printJSON(["default": "hd", "profiles": RemoteVideoQuality.allCases.map { ["quality": $0.rawValue, "bitRate": $0.bitRate] }])
    exit(0)
}
if CommandLine.arguments.contains("--self-test") {
    assert(handle("{}") != nil)
    print("remote-helper self-test passed")
    exit(0)
}
guard CommandLine.arguments.count == 3 else { exit(2) }
let socketPath = CommandLine.arguments[1]
guard socketPath.utf8.count < 104, let parent = Int32(CommandLine.arguments[2]) else { exit(2) }
let connection = socket(AF_UNIX, SOCK_STREAM, 0)
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
withUnsafeMutablePointer(to: &address.sun_path) { pointer in
    pointer.withMemoryRebound(to: CChar.self, capacity: 104) { dest in
        socketPath.withCString { source in _ = strcpy(dest, source) }
    }
}
let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(connection, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
guard connected == 0 else { exit(3) }
var noSignal: Int32 = 1
setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
let channel = FileHandle(fileDescriptor: connection, closeOnDealloc: true)
func respond(_ id: Int?, _ payload: [String: Any]) {
    DispatchQueue.main.async {
        do { try channel.write(contentsOf: Data((reply(id, payload) + "\n").utf8)) } catch { exit(0) }
    }
}
// Keep one capture stream alive; per-frame screenshots repeatedly start/stop capture.
final class RemoteCaptureStream: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    var latest: CGImage?
    var bounds = CGRect.zero
    var starting = false
    var waiting: [Int?] = []
    let context = CIContext()
    var selectedDisplayID: CGDirectDisplayID?
    var epoch = 0
    var quality = RemoteVideoQuality.hd
    func displays() -> [[String: Any]] {
        let primary = CGMainDisplayID()
        let screens = NSScreen.screens.sorted { a, b in
            let x = (a.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
            let y = (b.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
            return x == primary ? y != primary : (y != primary && x < y)
        }
        let selected = selectedDisplayID ?? primary
        return screens.enumerated().map { index, screen in
            let number = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as! NSNumber).uint32Value
            return ["id": String(number), "label": "第 \(index + 1) 屏 · \(screen.localizedName)", "primary": number == primary, "selected": number == selected]
        }
    }
    func select(_ id: Int?, displayID: String?) {
        guard let displayID, let number = UInt32(displayID), displays().contains(where: { $0["id"] as? String == displayID }) else {
            respond(id, ["ok": false, "error": "屏幕已断开，请刷新屏幕列表"]); return
        }
        if selectedDisplayID == number || (selectedDisplayID == nil && number == CGMainDisplayID()) { frame(id); return }
        selectedDisplayID = number
        restart(id)
    }
    func setQuality(_ id: Int?, value: String?) {
        guard let value, let next = RemoteVideoQuality(rawValue: value) else { respond(id, ["ok": false, "error": "未知画质档位"]); return }
        if quality == next { frame(id); return }
        quality = next
        remoteVideoEncoder.bitRate = next.bitRate
        restart(id)
    }
    func restart(_ id: Int?) {
        epoch += 1
        let currentEpoch = epoch
        let old = stream; stream = nil; latest = nil; starting = true
        let pending = waiting; waiting.removeAll()
        for request in pending { respond(request, ["ok": false, "error": "屏幕正在切换"]) }
        remoteVideoEncoder.reset()
        let restart = {
            guard self.epoch == currentEpoch else { return }
            self.starting = false
            self.frame(id)
        }
        if let old { old.stopCapture { _ in DispatchQueue.main.async(execute: restart) } }
        else { restart() }
    }
    func frame(_ id: Int?) {
        guard CGPreflightScreenCaptureAccess() else { respond(id, ["ok": false, "error": "请先授予屏幕录制权限"]); return }
        if let selectedDisplayID, !displays().contains(where: { $0["id"] as? String == String(selectedDisplayID) }) {
            select(id, displayID: String(CGMainDisplayID())); return
        }
        holdRemoteDisplay()
        if let latest { encode(id, latest); return }
        waiting.append(id)
        if starting || stream != nil { return }
        starting = true
        let currentEpoch = epoch
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            DispatchQueue.main.async {
                guard self.epoch == currentEpoch else { return }
                let target = self.selectedDisplayID ?? CGMainDisplayID()
                guard let display = content?.displays.first(where: { $0.displayID == target }) else { self.fail(error?.localizedDescription ?? "没有可采集的屏幕"); return }
                self.bounds = CGDisplayBounds(display.displayID)
                let config = SCStreamConfiguration()
                let mode = CGDisplayCopyDisplayMode(display.displayID)
                let dimensions = self.quality.dimensions(width: mode?.pixelWidth ?? display.width, height: mode?.pixelHeight ?? display.height)
                config.width = dimensions.0
                config.height = dimensions.1
                config.showsCursor = true
                config.minimumFrameInterval = CMTime(value: 1, timescale: 20)
                config.queueDepth = 3
                let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
                do { try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main) }
                catch { self.fail(error.localizedDescription); return }
                self.stream = stream
                stream.startCapture { error in DispatchQueue.main.async { guard self.stream === stream else { return }; self.starting = false; if let error { self.fail(error.localizedDescription) } } }
            }
        }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard self.stream === stream, type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
              let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        remoteVideoEncoder.encode(pixel, timestamp: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        let image = CIImage(cvPixelBuffer: pixel)
        guard let cg = context.createCGImage(image, from: image.extent) else { return }
        latest = cg
        let requests = waiting; waiting.removeAll()
        for id in requests { encode(id, cg) }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { DispatchQueue.main.async { if self.stream === stream { self.fail(error.localizedDescription) } } }
    func fail(_ message: String) {
        stream = nil; latest = nil; starting = false
        let requests = waiting; waiting.removeAll()
        for id in requests { respond(id, ["ok": false, "error": message]) }
    }
    func encode(_ id: Int?, _ image: CGImage) {
            // JPEG is the lightweight viewing fallback; H264 keeps the selected resolution.
            let scale = min(1, 1280.0 / Double(max(image.width, image.height)))
            let preview = CIImage(cgImage: image).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            guard let thumbnail = context.createCGImage(preview, from: preview.extent) else {
                respond(id, ["ok": false, "error": "屏幕预览编码失败"]); return
            }
            let bitmap = NSBitmapImageRep(cgImage: thumbnail)
            for quality in [0.7, 0.5, 0.3, 0.15] {
                if let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]), jpeg.count <= 640 * 1024 {
                    respond(id, ["ok": true, "data": jpeg.base64EncodedString(), "width": bounds.width, "height": bounds.height, "originX": bounds.minX, "originY": bounds.minY, "displayId": String(selectedDisplayID ?? CGMainDisplayID()), "displays": displays(), "quality": self.quality.rawValue]); return
                }
            }
            respond(id, ["ok": false, "error": "屏幕帧过大"])
    }
}
let remoteCapture = RemoteCaptureStream()
func capture(_ id: Int?) { remoteCapture.frame(id) }
func remoteCommand(_ line: String) {
    guard let data = line.data(using: .utf8), let cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
    let id = (cmd["id"] as? NSNumber)?.intValue
    switch cmd["op"] as? String {
    case "status": respond(id, ["ok": true, "screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()])
    case "authorize":
        if cmd["permission"] as? String == "screen" {
            _ = CGRequestScreenCaptureAccess()
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
        } else if cmd["permission"] as? String == "accessibility" {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
        } else { respond(id, ["ok": false, "error": "未知权限"]); return }
        respond(id, ["ok": true])
    case "video":
        if cmd["enabled"] as? Bool == true { remoteVideoEncoder.enabled = true; remoteVideoEncoder.forceKeyframe = true }
        else { remoteVideoEncoder.stop() }
        respond(id, ["ok": true])
    case "displays": respond(id, ["ok": true, "displays": remoteCapture.displays()])
    case "set-quality": remoteCapture.setQuality(id, value: cmd["quality"] as? String)
    case "set-display": remoteCapture.select(id, displayID: cmd["displayId"] as? String)
    case "capture": capture(id)
    case "quit": exit(0)
    default:
        guard AXIsProcessTrusted() else { respond(id, ["ok": false, "error": "请先授予辅助功能权限"]); return }
        wakeRemoteDisplay()
        if let response = handle(line) { try? channel.write(contentsOf: Data((response + "\n").utf8)) }
    }
}
var buffer = Data()
let source = DispatchSource.makeReadSource(fileDescriptor: connection, queue: .main)
source.setEventHandler {
    let chunk = channel.availableData
    if chunk.isEmpty { exit(0) }
    buffer.append(chunk)
    if buffer.count > 65536 { exit(4) }
    while let newline = buffer.firstIndex(of: 10) {
        let line = buffer.prefix(upTo: newline)
        if let text = String(data: line, encoding: .utf8) { remoteCommand(text) }
        buffer.removeSubrange(...newline)
    }
}
source.resume()
let parentTimer = DispatchSource.makeTimerSource(queue: .main)
parentTimer.schedule(deadline: .now() + 2, repeating: 2)
parentTimer.setEventHandler { if kill(parent, 0) != 0 { exit(0) } }
parentTimer.resume()
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
