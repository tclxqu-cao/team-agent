import Foundation
import CoreVideo
import CoreMedia
import CoreGraphics
import ImageIO
import CryptoKit

final class RemoteCompoundImageCache {
    var entries: [String: (Data, Double)] = [:]
    var order: [String] = []
    var bytes = 0
    var encodes = 0
    var hits = 0
    var scans = 0
    func get(_ key: String) -> (Data, Double)? {
        guard let entry = entries[key] else { return nil }
        hits += 1; order.removeAll { $0 == key }; order.append(key); return entry
    }
    func put(_ key: String, _ data: Data, _ entropy: Double) {
        encodes += 1
        while bytes + data.count > 16 * 1024 * 1024 || entries.count >= 1024 {
            guard !order.isEmpty else { break }
            let key = order.removeFirst(); bytes -= entries.removeValue(forKey: key)?.0.count ?? 0
        }
        entries[key] = (data, entropy); order.append(key); bytes += data.count
    }
}

/// Captures immutable inputs on main; expensive image work stays on one bounded worker.
final class RemoteCompoundCapture {
    private let worker = DispatchQueue(label: "com.agentroam.remote.compound", qos: .utility)
    private(set) var enabled = false
    private var generation = 0
    private var epoch = 0
    private var revision = 0
    private var dimensions = (0, 0)
    private var previousCapture: CVPixelBuffer?
    private var refinedFrames = 0, falseDirtyFrames = 0, refinementFallbacks = 0
    private var comparedBlocks = 0
    private var refinementMaxMs = 0.0
    private var latest: (CVPixelBuffer, Double)?
    private var busy = false
    private var cursor = 0
    private var imageCache = RemoteCompoundImageCache() // Worker-owned after capture into sample closure.
    private var scrollBase: (CVPixelBuffer, Int)?
    private var changeRect: CGRect?
    private var capturedAt = 0.0
    var onMetadata: (([String: Any]) -> Void)?
    var contentVersion: RemoteVideoContentVersion { RemoteVideoContentVersion(epoch: epoch, revision: revision) }

    func configure(_ enabled: Bool) {
        self.enabled = enabled
        reset()
    }

    func reset() {
        generation += 1; epoch += 1; revision = 0
        dimensions = (0, 0); latest = nil; previousCapture = nil; cursor = 0; busy = false
        refinedFrames = 0; falseDirtyFrames = 0; refinementFallbacks = 0; comparedBlocks = 0; refinementMaxMs = 0
        imageCache = RemoteCompoundImageCache(); scrollBase = nil; changeRect = nil
    }

    func noteChange(_ pixel: CVPixelBuffer, timestamp: Double, dirtyRects: [CGRect]?) {
        guard enabled else { return }
        let size = (CVPixelBufferGetWidth(pixel), CVPixelBufferGetHeight(pixel))
        let resized = dimensions != size
        if resized { reset(); dimensions = size }
        let prior = previousCapture
        previousCapture = pixel // At most one extra retained capture; never accumulate a frame queue.
        var changedRects = dirtyRects
        if !resized, dirtyRects == nil || !dirtyRects!.isEmpty, let prior {
            let began = DispatchTime.now().uptimeNanoseconds
            let refined = Self.refineDirty(prior, pixel, rects: dirtyRects)
            refinementMaxMs = max(refinementMaxMs, Double(DispatchTime.now().uptimeNanoseconds - began) / 1_000_000)
            comparedBlocks += refined.compared
            if let rects = refined.rects {
                refinedFrames += 1
                if rects.isEmpty { falseDirtyFrames += 1; return }
                changedRects = rects
            } else { refinementFallbacks += 1 }
        }
        if resized || changedRects == nil || !changedRects!.isEmpty {
            scrollBase = latest.map { ($0.0, revision) }
            changeRect = changedRects?.reduce(CGRect.null) { $0.union($1) }
            revision += 1
            latest = nil
            var event = metadata(kind: "invalidate", timestamp: timestamp)
            // SDK SCStreamFrameInfoDirtyRects: pixel-space NSValue CGRects.
            // Expand to full tiles; uncertain geometry invalidates the whole layer.
            if !resized, let rects = changedRects, !rects.isEmpty, rects.count <= 32,
               rects.allSatisfy({ $0.minX.isFinite && $0.minY.isFinite && $0.width.isFinite && $0.height.isFinite
                   && $0.minX >= 0 && $0.minY >= 0 && $0.maxX <= Double(size.0) && $0.maxY <= Double(size.1) }) {
                event["rects"] = rects.filter { !$0.isEmpty }.map { rect -> [String: Int] in
                    let x = Int(floor(rect.minX / 64)) * 64, y = Int(floor(rect.minY / 64)) * 64
                    let right = min(size.0, Int(ceil(rect.maxX / 64)) * 64)
                    let bottom = min(size.1, Int(ceil(rect.maxY / 64)) * 64)
                    return ["x": x, "y": y, "width": right - x, "height": bottom - y]
                }
            }
            onMetadata?(event)
        }
    }

    /// Refine OS hints with exact comparisons. A time/geometry failure conservatively keeps the hint.
    static func refineDirty(_ old: CVPixelBuffer, _ new: CVPixelBuffer, rects: [CGRect]?, budgetNs: UInt64 = 2_000_000) -> (rects: [CGRect]?, compared: Int) {
        let began = DispatchTime.now().uptimeNanoseconds
        let width = CVPixelBufferGetWidth(new), height = CVPixelBufferGetHeight(new)
        guard width > 0, height > 0, width <= 4096, height <= 4096, width * height <= 8_388_608,
              width == CVPixelBufferGetWidth(old), height == CVPixelBufferGetHeight(old),
              CVPixelBufferGetPixelFormatType(old) == kCVPixelFormatType_32BGRA,
              CVPixelBufferGetPixelFormatType(new) == kCVPixelFormatType_32BGRA else { return (nil, 0) }
        let hints = rects ?? [CGRect(x: 0, y: 0, width: width, height: height)]
        guard hints.count <= 32, hints.allSatisfy({ $0.minX.isFinite && $0.minY.isFinite && $0.width.isFinite && $0.height.isFinite
            && $0.width >= 0 && $0.height >= 0 && $0.minX >= 0 && $0.minY >= 0 && $0.maxX <= Double(width) && $0.maxY <= Double(height) }) else { return (nil, 0) }
        let columns = (width + 63) / 64
        var candidates = Set<Int>()
        for rect in hints where !rect.isEmpty {
            for row in Int(floor(rect.minY / 64))..<Int(ceil(rect.maxY / 64)) {
                for col in Int(floor(rect.minX / 64))..<Int(ceil(rect.maxX / 64)) { candidates.insert(row * columns + col) }
            }
        }
        guard CVPixelBufferLockBaseAddress(old, .readOnly) == kCVReturnSuccess else { return (nil, 0) }
        defer { CVPixelBufferUnlockBaseAddress(old, .readOnly) }
        guard CVPixelBufferLockBaseAddress(new, .readOnly) == kCVReturnSuccess else { return (nil, 0) }
        defer { CVPixelBufferUnlockBaseAddress(new, .readOnly) }
        guard let a = CVPixelBufferGetBaseAddress(old), let b = CVPixelBufferGetBaseAddress(new) else { return (nil, 0) }
        let ar = CVPixelBufferGetBytesPerRow(old), br = CVPixelBufferGetBytesPerRow(new)
        var changed: [CGRect] = [], compared = 0
        for index in candidates.sorted() {
            if DispatchTime.now().uptimeNanoseconds - began >= budgetNs { return (nil, compared) }
            let x = index % columns * 64, y = index / columns * 64
            let w = min(64, width - x), h = min(64, height - y)
            var different = false
            for row in 0..<h {
                if memcmp(a.advanced(by: (y + row) * ar + x * 4), b.advanced(by: (y + row) * br + x * 4), w * 4) != 0 { different = true; break }
            }
            compared += 1
            if different {
                // Merge adjacent tiles on one row to keep the invalidation wire geometry bounded.
                if let last = changed.last, last.minY == Double(y), last.maxX == Double(x), last.height == Double(h) {
                    changed[changed.count - 1] = last.union(CGRect(x: x, y: y, width: w, height: h))
                } else { changed.append(CGRect(x: x, y: y, width: w, height: h)) }
                if changed.count > 32 { return (nil, compared) }
            }
        }
        return (changed, compared)
    }

    func noteEncoded(_ pixel: CVPixelBuffer, timestamp: Double, contentVersion: RemoteVideoContentVersion) {
        guard enabled, timestamp.isFinite, timestamp >= 0, contentVersion == self.contentVersion,
              CVPixelBufferGetWidth(pixel) == dimensions.0, CVPixelBufferGetHeight(pixel) == dimensions.1 else { return }
        latest = (pixel, timestamp)
        let sourceAge = max(0, CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) - timestamp)
        capturedAt = Date().timeIntervalSince1970 * 1000 - sourceAge * 1000
        onMetadata?(metadata(kind: "frame", timestamp: timestamp))
    }

    private func metadata(kind: String, timestamp: Double) -> [String: Any] {
        ["event": "compound", "kind": kind, "epoch": epoch, "revision": revision,
         "timestamp": timestamp, "capturedAt": capturedAt, "width": dimensions.0, "height": dimensions.1,
         "refinement": ["frames": refinedFrames, "falseDirtyFrames": falseDirtyFrames, "fallbacks": refinementFallbacks,
             "comparedBlocks": comparedBlocks, "maxMs": refinementMaxMs]]
    }

    func sample(maxBytes: Int, maxEntropy: Double, priorityIndices: [Int] = [], selectedOnly: Bool = false, completion: @escaping ([String: Any]) -> Void) {
        guard enabled, !busy, let (pixel, timestamp) = latest else {
            completion(["ok": true, "stale": true]); return
        }
        guard CVPixelBufferGetPixelFormatType(pixel) == kCVPixelFormatType_32BGRA,
              dimensions.0 > 0, dimensions.1 > 0, dimensions.0 <= 4096, dimensions.1 <= 4096,
              dimensions.0 * dimensions.1 <= 8_388_608 else {
            completion(["ok": false, "error": "Compound capture dimensions or pixel format unsupported"]); return
        }
        busy = true
        let token = generation, version = revision, start = cursor
        let cache = imageCache, base = scrollBase, rect = changeRect
        scrollBase = nil
        var envelope = metadata(kind: "sample", timestamp: timestamp)
        envelope.removeValue(forKey: "event")
        worker.async {
            let scroll = base.flatMap { Self.detectScroll($0.0, pixel, sourceRevision: $0.1, rect: rect) }
            let result = Self.extract(pixel, start: start, maxBytes: min(128 * 1024, max(1024, maxBytes)), maxEntropy: maxEntropy, priorityIndices: priorityIndices, selectedOnly: selectedOnly, cache: cache)
            DispatchQueue.main.async {
                guard self.generation == token else { completion(["ok": true, "stale": true]); return }
                self.busy = false
                guard self.enabled, self.revision == version else { completion(["ok": true, "stale": true]); return }
                self.cursor = result.cursor
                envelope["ok"] = true
                envelope["tiles"] = result.tiles
                if let scroll { envelope["scroll"] = scroll }
                envelope["extraction"] = ["pngEncodes": cache.encodes, "pngCacheHits": cache.hits, "scannedBlocks": cache.scans]
                completion(envelope)
            }
        }
    }

    private static func entropy(_ data: Data, width: Int, height: Int) -> Double {
        var bins = Array(repeating: 0, count: 768)
        var samples = 0
        data.withUnsafeBytes { bytes in
            let pixels = bytes.bindMemory(to: UInt8.self)
            for y in stride(from: 0, to: height, by: 2) {
                for x in stride(from: 0, to: width, by: 2) {
                    let offset = (y * width + x) * 4
                    bins[Int(pixels[offset])] += 1
                    bins[256 + Int(pixels[offset + 1])] += 1
                    bins[512 + Int(pixels[offset + 2])] += 1
                    samples += 1
                }
            }
        }
        guard samples > 0 else { return 24 }
        return bins.reduce(0.0) { sum, count in
            guard count > 0 else { return sum }
            let probability = Double(count) / Double(samples)
            return sum - probability * log2(probability)
        }
    }

    private static func png(_ data: Data, width: Int, height: Int) -> Data? {
        guard let provider = CGDataProvider(data: data as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                  bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue),
                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { return nil }
        let result = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(result, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? result as Data : nil
    }

    /// A round-robin cursor prevents large static desktops starving tiles at the bottom.
    static func extract(_ pixel: CVPixelBuffer, start: Int, maxBytes: Int, maxEntropy: Double, priorityIndices: [Int] = [], selectedOnly: Bool = false, cache: RemoteCompoundImageCache = RemoteCompoundImageCache()) -> (tiles: [[String: Any]], cursor: Int) {
        CVPixelBufferLockBaseAddress(pixel, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixel, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixel) else { return ([], start) }
        let width = CVPixelBufferGetWidth(pixel), height = CVPixelBufferGetHeight(pixel)
        let rowBytes = CVPixelBufferGetBytesPerRow(pixel)
        let columns = (width + 63) / 64, rows = (height + 63) / 64, count = columns * rows
        guard count > 0 else { return ([], 0) }
        let began = DispatchTime.now().uptimeNanoseconds
        var seen = Set<Int>()
        let indices = (Array(priorityIndices.prefix(128)) + (selectedOnly ? [] : (0..<count).map { (start + $0) % count })).filter { $0 >= 0 && $0 < count && seen.insert($0).inserted }
        var tiles: [[String: Any]] = [], bytes = 256, scanned = 0
        while scanned < indices.count && tiles.count < 128 {
            cache.scans += 1
            let index = indices[scanned]
            let x = (index % columns) * 64, y = (index / columns) * 64
            let w = min(64, width - x), h = min(64, height - y)
            var raster = Data(count: w * h * 4)
            raster.withUnsafeMutableBytes { target in
                for row in 0..<h {
                    memcpy(target.baseAddress!.advanced(by: row * w * 4), base.advanced(by: (y + row) * rowBytes + x * 4), w * 4)
                }
            }
            var identity = Data([UInt8(w), UInt8(h)]); identity.append(raster)
            let key = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
            let cached = cache.get(key)
            let complexity = cached?.1 ?? entropy(raster, width: w, height: h)
            if complexity <= maxEntropy, let encoded = cached?.0 ?? png(raster, width: w, height: h), encoded.count <= 32_768 {
                if cached == nil { cache.put(key, encoded, complexity) }
                let cost = 192 + ((encoded.count + 2) / 3) * 4
                if bytes + cost > maxBytes { break }
                tiles.append(["key": key, "x": x, "y": y, "width": w, "height": h,
                    "entropy": complexity, "data": encoded.base64EncodedString()])
                bytes += cost
            }
            scanned += 1
            if DispatchTime.now().uptimeNanoseconds - began >= 30_000_000 { break }
        }
        // An oversized tile must not hold the cursor forever.
        return (tiles, (start + max(1, scanned)) % count)
    }

    /// Candidate search samples only; a copy is emitted only after exact overlap comparison.
    static func detectScroll(_ old: CVPixelBuffer, _ new: CVPixelBuffer, sourceRevision: Int, rect: CGRect?) -> [String: Int]? {
        let width = CVPixelBufferGetWidth(new), height = CVPixelBufferGetHeight(new)
        guard width == CVPixelBufferGetWidth(old), height == CVPixelBufferGetHeight(old), width >= 64, height >= 64 else { return nil }
        let area = (rect ?? CGRect(x: 0, y: 0, width: width, height: height)).intersection(CGRect(x: 0, y: 0, width: width, height: height)).integral
        guard !area.isNull, area.width >= 64, area.height >= 64 else { return nil }
        CVPixelBufferLockBaseAddress(old, .readOnly); CVPixelBufferLockBaseAddress(new, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(old, .readOnly); CVPixelBufferUnlockBaseAddress(new, .readOnly) }
        guard let a = CVPixelBufferGetBaseAddress(old), let b = CVPixelBufferGetBaseAddress(new) else { return nil }
        let ar = CVPixelBufferGetBytesPerRow(old), br = CVPixelBufferGetBytesPerRow(new)
        let x0 = Int(area.minX), y0 = Int(area.minY), w = Int(area.width), h = Int(area.height)
        func score(_ dx: Int, _ dy: Int) -> Int {
            let left = x0 + max(0, dx), top = y0 + max(0, dy), cw = w - abs(dx), ch = h - abs(dy)
            guard cw > 16, ch > 16 else { return 0 }
            var matches = 0
            for row in 1...6 { for col in 1...8 {
                let x = left + col * cw / 9, y = top + row * ch / 7
                if memcmp(a.advanced(by: (y - dy) * ar + (x - dx) * 4), b.advanced(by: y * br + x * 4), 4) == 0 { matches += 1 }
            } }
            return matches
        }
        let baseline = score(0, 0)
        guard baseline < 46 else { return nil }
        var best = baseline, dx = 0, dy = 0
        for axis in 0...1 {
            let radius = min(256, (axis == 0 ? w : h) / 2)
            for shift in -radius...radius where shift != 0 {
                let value = score(axis == 0 ? shift : 0, axis == 1 ? shift : 0)
                if value > best { best = value; dx = axis == 0 ? shift : 0; dy = axis == 1 ? shift : 0 }
            }
        }
        guard best == 48 else { return nil }
        let x = x0 + max(0, dx), y = y0 + max(0, dy), cw = w - abs(dx), ch = h - abs(dy)
        for row in y..<(y + ch) {
            if memcmp(a.advanced(by: (row - dy) * ar + (x - dx) * 4), b.advanced(by: row * br + x * 4), cw * 4) != 0 { return nil }
        }
        return ["sourceRevision": sourceRevision, "sourceX": x - dx, "sourceY": y - dy, "x": x, "y": y, "width": cw, "height": ch]
    }

    static func selfTest() {
        var buffer: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 130, 66, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess)
        let pixel = buffer!
        CVPixelBufferLockBaseAddress(pixel, [])
        let pointer = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(pixel)
        for y in 0..<66 { for x in 0..<130 {
            let at = y * stride + x * 4
            pointer[at] = x % 2 == 0 ? 0 : 255
            pointer[at + 1] = pointer[at]; pointer[at + 2] = pointer[at]; pointer[at + 3] = 255
        } }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        let first = extract(pixel, start: 0, maxBytes: 128 * 1024, maxEntropy: 6.3)
        precondition(!first.tiles.isEmpty)
        let tile = first.tiles[0]
        precondition((tile["entropy"] as! Double) <= 6.3)
        let data = Data(base64Encoded: tile["data"] as! String)!
        let source = CGImageSourceCreateWithData(data as CFData, nil)!
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        precondition(image.width == 64 && image.height == 64)
        let repeated = extract(pixel, start: 0, maxBytes: 128 * 1024, maxEntropy: 6.3)
        precondition(repeated.tiles[0]["key"] as! String == tile["key"] as! String)
        let edge = extract(pixel, start: 5, maxBytes: 128 * 1024, maxEntropy: 6.3).tiles[0]
        precondition(edge["width"] as! Int == 2 && edge["height"] as! Int == 2)
        let noise = Data((0..<(64 * 64 * 4)).map { UInt8(truncatingIfNeeded: ($0 * 37) ^ ($0 >> 3)) })
        precondition(entropy(noise, width: 64, height: 64) > 6.3)
        precondition(extract(pixel, start: 0, maxBytes: 256, maxEntropy: 6.3).tiles.isEmpty)
        let cache = RemoteCompoundImageCache()
        _ = extract(pixel, start: 0, maxBytes: 128 * 1024, maxEntropy: 24, cache: cache)
        let encodes = cache.encodes
        let prioritized = extract(pixel, start: 0, maxBytes: 128 * 1024, maxEntropy: 24, priorityIndices: [5], cache: cache)
        precondition(cache.encodes == encodes && cache.hits > 0)
        precondition(prioritized.tiles[0]["x"] as! Int == 128 && prioritized.tiles[0]["y"] as! Int == 64)
        let scans = cache.scans
        let selected = extract(pixel, start: 0, maxBytes: 128 * 1024, maxEntropy: 24, priorityIndices: [5, 5, -1, 100], selectedOnly: true, cache: cache)
        precondition(selected.tiles.count == 1 && cache.scans == scans + 1)
        precondition(extract(pixel, start: 0, maxBytes: 128 * 1024, maxEntropy: 24, selectedOnly: true, cache: cache).tiles.isEmpty)
        precondition(cache.scans == scans + 1)
        var oldBuffer: CVPixelBuffer?, newBuffer: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 128, 128, kCVPixelFormatType_32BGRA, nil, &oldBuffer) == kCVReturnSuccess)
        precondition(CVPixelBufferCreate(nil, 128, 128, kCVPixelFormatType_32BGRA, nil, &newBuffer) == kCVReturnSuccess)
        let old = oldBuffer!, new = newBuffer!
        CVPixelBufferLockBaseAddress(old, []); CVPixelBufferLockBaseAddress(new, [])
        let oldBase = CVPixelBufferGetBaseAddress(old)!, newBase = CVPixelBufferGetBaseAddress(new)!
        let oldStride = CVPixelBufferGetBytesPerRow(old), newStride = CVPixelBufferGetBytesPerRow(new)
        memset(newBase, 0, CVPixelBufferGetDataSize(new))
        for y in 0..<128 { for x in 0..<128 {
            let value = UInt32(x) &* 2654435761 ^ UInt32(y) &* 2246822519
            oldBase.storeBytes(of: value, toByteOffset: y * oldStride + x * 4, as: UInt32.self)
        } }
        for y in 0..<111 { memcpy(newBase.advanced(by: y * newStride), oldBase.advanced(by: (y + 17) * oldStride), 128 * 4) }
        CVPixelBufferUnlockBaseAddress(old, []); CVPixelBufferUnlockBaseAddress(new, [])
        let scroll = detectScroll(old, new, sourceRevision: 4, rect: nil)
        precondition(scroll?["sourceY"] == 17 && scroll?["height"] == 111)
        CVPixelBufferLockBaseAddress(new, [])
        newBase.storeBytes(of: UInt32(123), toByteOffset: 100 * newStride + 4, as: UInt32.self)
        CVPixelBufferUnlockBaseAddress(new, [])
        precondition(detectScroll(old, new, sourceRevision: 4, rect: nil) == nil)
        // A coarse OS hint must neither discard a sharp static layer nor hide a changed pixel.
        let whole = CGRect(x: 0, y: 0, width: 128, height: 128)
        precondition(refineDirty(old, old, rects: [whole]).rects?.isEmpty == true)
        precondition(refineDirty(old, new, rects: [whole], budgetNs: 0).rects == nil)
        precondition(refineDirty(old, new, rects: [CGRect(x: -1, y: 0, width: 128, height: 128)]).rects == nil)
        CVPixelBufferLockBaseAddress(old, .readOnly); CVPixelBufferLockBaseAddress(new, [])
        for y in 0..<128 { memcpy(newBase.advanced(by: y * newStride), oldBase.advanced(by: y * oldStride), 128 * 4) }
        newBase.storeBytes(of: UInt32(42), toByteOffset: 127 * newStride + 127 * 4, as: UInt32.self)
        CVPixelBufferUnlockBaseAddress(new, []); CVPixelBufferUnlockBaseAddress(old, .readOnly)
        let refined = refineDirty(old, new, rects: [whole])
        precondition(refined.rects == [CGRect(x: 64, y: 64, width: 64, height: 64)])
        let capture = RemoteCompoundCapture(); capture.configure(true)
        var events: [[String: Any]] = []; capture.onMetadata = { events.append($0) }
        capture.noteChange(old, timestamp: 1, dirtyRects: nil)
        let version = capture.contentVersion
        capture.noteEncoded(old, timestamp: 1, contentVersion: version)
        let eventCount = events.count
        for _ in 0..<20 { capture.noteChange(old, timestamp: 2, dirtyRects: [whole]) }
        precondition(capture.contentVersion == version && events.count == eventCount)
        capture.noteChange(new, timestamp: 3, dirtyRects: [whole])
        precondition(capture.contentVersion.revision == version.revision + 1)
        precondition((events.last?["rects"] as? [[String: Int]]) == [["x": 64, "y": 64, "width": 64, "height": 64]])
        capture.noteEncoded(old, timestamp: 1, contentVersion: version)
        precondition(events.last?["kind"] as? String == "invalidate")
        print("compound capture self-test passed")
    }
}

let remoteCompoundCapture = RemoteCompoundCapture()
