// This suffix is built with the existing input helper's functions, not its stdin loop.
import ScreenCaptureKit
import Darwin
import CoreImage
import CoreMedia

if CommandLine.arguments.contains("--config") || CommandLine.arguments.contains("--diagnose") || CommandLine.arguments.contains("--request-permissions") {
    runStandaloneService()
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
    func frame(_ id: Int?) {
        guard CGPreflightScreenCaptureAccess() else { respond(id, ["ok": false, "error": "请先授予屏幕录制权限"]); return }
        if let latest { encode(id, latest); return }
        waiting.append(id)
        if starting || stream != nil { return }
        starting = true
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            DispatchQueue.main.async {
                guard let display = content?.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content?.displays.first else { self.fail(error?.localizedDescription ?? "没有可采集的屏幕"); return }
                self.bounds = CGDisplayBounds(display.displayID)
                let config = SCStreamConfiguration()
                let scale = min(1.0, 1280.0 / Double(display.width))
                config.width = max(1, Int(Double(display.width) * scale))
                config.height = max(1, Int(Double(display.height) * scale))
                config.showsCursor = true
                config.minimumFrameInterval = CMTime(value: 1, timescale: 20)
                config.queueDepth = 3
                let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
                do { try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main) }
                catch { self.fail(error.localizedDescription); return }
                self.stream = stream
                stream.startCapture { error in DispatchQueue.main.async { self.starting = false; if let error { self.fail(error.localizedDescription) } } }
            }
        }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
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
    func stream(_ stream: SCStream, didStopWithError error: Error) { DispatchQueue.main.async { self.fail(error.localizedDescription) } }
    func fail(_ message: String) {
        stream = nil; latest = nil; starting = false
        let requests = waiting; waiting.removeAll()
        for id in requests { respond(id, ["ok": false, "error": message]) }
    }
    func encode(_ id: Int?, _ image: CGImage) {
            let bitmap = NSBitmapImageRep(cgImage: image)
            for quality in [0.7, 0.5, 0.3, 0.15] {
                if let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]), jpeg.count <= 640 * 1024 {
                    respond(id, ["ok": true, "data": jpeg.base64EncodedString(), "width": bounds.width, "height": bounds.height, "originX": bounds.minX, "originY": bounds.minY]); return
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
    case "capture": capture(id)
    case "quit": exit(0)
    default:
        guard AXIsProcessTrusted() else { respond(id, ["ok": false, "error": "请先授予辅助功能权限"]); return }
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
