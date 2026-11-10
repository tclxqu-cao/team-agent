import AppKit
import CoreMedia

/// Local encoding cache and unreliable-channel refresh cadence; no network or application decisions.
final class RemoteCursorShapeCache {
    private var key = ""
    private var refreshAt = -Double.infinity
    private var shape: [String: Any]?
    func value(key: String, now: Double, encode: () -> [String: Any]?) -> [String: Any]? {
        if self.key != key || now - refreshAt >= 1 {
            self.key = key; refreshAt = now; shape = encode()
        }
        return shape
    }
}
struct RemoteCursorEmission {
    private var signature = ""
    private var emittedAt = -Double.infinity
    mutating func shouldEmit(signature: String, now: Double) -> Bool {
        guard self.signature != signature || now - emittedAt >= 0.5 else { return false }
        self.signature = signature; emittedAt = now; return true
    }
}
final class RemoteCursorStream {
    private var timer: Timer?
    private var cutover = CMTime.invalid
    private var activation: UInt32?
    private var sequence = 0
    private var shapeAt = -Double.infinity
    private var shapeKey = ""
    private var cache = RemoteCursorShapeCache()
    private var emission = RemoteCursorEmission()
    private var shapeImage: NSImage?
    var onMetadata: (([String: Any]) -> Void)?
    func configure(_ enabled: Bool) {
        timer?.invalidate(); timer = nil; activation = nil; shapeKey = ""; shapeAt = -.infinity
        cache = RemoteCursorShapeCache(); emission = RemoteCursorEmission(); shapeImage = nil
        guard enabled else {
            sequence += 1; onMetadata?(["event": "cursor", "sequence": sequence, "active": false, "visible": false, "x": 0, "y": 0, "cutoverRtp": 0]); return
        }
        cutover = CMClockGetTime(CMClockGetHostTimeClock())
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.sample() }
    }
    private func sample() {
        let timestamp = remoteVideoEncoder.lastEncodedTimestamp
        guard timestamp.isValid, CMTimeCompare(timestamp, cutover) >= 0 else { return }
        if activation == nil { activation = UInt32(truncatingIfNeeded: Int64((CMTimeGetSeconds(timestamp) * 90_000).rounded())) }
        let bounds = remoteCapture.bounds
        guard bounds.width > 0, bounds.height > 0, let position = CGEvent(source: nil)?.location else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let visible = bounds.contains(position), x = min(1, max(0, (position.x - bounds.minX) / bounds.width)), y = min(1, max(0, (position.y - bounds.minY) / bounds.height))
        let scale = Double(remoteCapture.configuration?.width ?? Int(bounds.width)) / bounds.width
        var shape: [String: Any]?, key = "none"
        if let cursor = NSCursor.currentSystem {
            let image = cursor.image
            key = "\(ObjectIdentifier(image))-\(image.size)-\(cursor.hotSpot)-\(scale)"
            shape = cache.value(key: key, now: now) {
                guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                      bitmap.pixelsWide <= 64, bitmap.pixelsHigh <= 64,
                      let png = bitmap.representation(using: .png, properties: [:]), png.count <= 6144 else { return nil }
                return ["image": png.base64EncodedString(), "hotX": cursor.hotSpot.x * scale, "hotY": cursor.hotSpot.y * scale,
                    "drawWidth": image.size.width * scale, "drawHeight": image.size.height * scale]
            }
            shapeImage = image // Keep the identity alive until the next image replaces it.
        }
        let resendShape = key != shapeKey || now - shapeAt >= 1
        guard emission.shouldEmit(signature: "\(x),\(y),\(visible),\(key),\(activation!)", now: now) || resendShape else { return }
        sequence += 1
        var event: [String: Any] = ["event": "cursor", "sequence": sequence, "active": true, "visible": visible,
            "x": x, "y": y, "cutoverRtp": activation!]
        if resendShape {
            if let shape { event.merge(shape) { _, new in new } }
            shapeKey = key; shapeAt = now
        }
        onMetadata?(event)
    }
    static func selfTest() {
        let cache = RemoteCursorShapeCache(); var encodes = 0, messages = 0; var emission = RemoteCursorEmission()
        for n in 0..<30 {
            let now = Double(n) / 30
            _ = cache.value(key: "arrow", now: now) { encodes += 1; return ["image": "png"] }
            if emission.shouldEmit(signature: "stationary", now: now) { messages += 1 }
        }
        precondition(encodes == 1 && messages == 2)
        _ = cache.value(key: "arrow", now: 1.1) { encodes += 1; return ["image": "refresh"] }
        _ = cache.value(key: "text", now: 1.2) { encodes += 1; return ["image": "changed"] }
        precondition(encodes == 3 && emission.shouldEmit(signature: "moved", now: 1.2))
        precondition(emission.shouldEmit(signature: "hidden", now: 1.21))
        print("cursor cache self-test passed: 30 static samples, one encode, two heartbeats; refresh/shape/move/visibility verified")
    }
}
let remoteCursorStream = RemoteCursorStream()
