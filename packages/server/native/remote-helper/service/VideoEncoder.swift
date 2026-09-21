import Foundation
import VideoToolbox
import CoreMedia

enum RemoteVideoQuality: String, CaseIterable {
    case smooth, hd, original
    var bitRate: Int { switch self { case .smooth: return 2_000_000; case .hd: return 8_000_000; case .original: return 20_000_000 } }
    var maxEdge: Double? { switch self { case .smooth: return 1280; case .hd: return 2560; case .original: return nil } }
    func dimensions(width: Int, height: Int) -> (Int, Int) {
        let ratio = min(1, (maxEdge ?? Double(max(width, height))) / Double(max(1, max(width, height))))
        return (max(2, Int(Double(width) * ratio) / 2 * 2), max(2, Int(Double(height) * ratio) / 2 * 2))
    }
}

enum RemoteH264Profile: String, CaseIterable {
    case high, baseline
    var videoToolboxValue: CFString {
        switch self {
        case .high: return kVTProfileLevel_H264_High_AutoLevel
        case .baseline: return kVTProfileLevel_H264_Baseline_AutoLevel
        }
    }
}

private final class RemoteVideoEncodeContext {
    let generation: UInt64
    let submittedAt: UInt64
    init(generation: UInt64, submittedAt: UInt64) {
        self.generation = generation
        self.submittedAt = submittedAt
    }
}

final class RemoteVideoEncoder {
    var session: VTCompressionSession?
    var enabled = false
    var bitRate = RemoteVideoQuality.hd.bitRate
    var maxFps = 30
    var profile = RemoteH264Profile.baseline
    var lastEncodedTimestamp = CMTime.invalid
    var forceKeyframe = true
    var onError: ((String) -> Void)?

    private let metricsLock = NSLock()
    private var generation: UInt64 = 0
    private var pendingFrames = 0
    private var encodeLatencyMs = 0.0
    private var droppedSinceSnapshot = 0
    private var statsSequence: UInt64 = 0
    private var lastActivityAt = Date().timeIntervalSince1970 * 1000
    private var activity = "motion"
    private var activityConfidence = 0.5

    func start(profile: RemoteH264Profile, bitRate: Int, maxFps: Int) {
        self.profile = profile
        self.bitRate = bitRate
        self.maxFps = maxFps
        enabled = true
        reset()
    }

    func setTuning(bitRate: Int, maxFps: Int) {
        self.bitRate = bitRate
        self.maxFps = maxFps
        guard let session else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitRate as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: maxFps as CFNumber)
    }

    func reset() {
        metricsLock.lock()
        generation &+= 1
        pendingFrames = 0
        encodeLatencyMs = 0
        droppedSinceSnapshot = 0
        statsSequence &+= 1
        metricsLock.unlock()
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        lastEncodedTimestamp = .invalid
        forceKeyframe = true
    }

    func stop() {
        enabled = false
        reset()
    }

    func noteActivity(dirtyRatio: Double?, idle: Bool = false) {
        let now = Date().timeIntervalSince1970 * 1000
        let next: (String, Double)
        if idle { next = ("idle", 0.95) }
        else if let dirtyRatio, dirtyRatio >= 0.15 { next = ("motion", 0.9) }
        else if let dirtyRatio, dirtyRatio >= 0.002 { next = ("interactive", 0.8) }
        else { next = ("idle", dirtyRatio == nil ? 0.65 : 0.8) }
        metricsLock.lock()
        activity = next.0
        activityConfidence = next.1
        lastActivityAt = now
        statsSequence &+= 1
        metricsLock.unlock()
    }

    func stats() -> [String: Any] {
        let now = Date().timeIntervalSince1970 * 1000
        metricsLock.lock()
        if now - lastActivityAt >= 3_000 {
            activity = "idle"
            activityConfidence = 0.95
        }
        let result: [String: Any] = [
            "pendingFrames": pendingFrames,
            "encodeLatencyMs": encodeLatencyMs,
            "droppedFrames": droppedSinceSnapshot,
            "sequence": statsSequence,
            "sampledAt": now,
            "activity": activity,
            "activityConfidence": activityConfidence,
            "profile": profile.rawValue,
        ]
        droppedSinceSnapshot = 0
        metricsLock.unlock()
        return result
    }

    func encode(_ pixel: CVPixelBuffer, timestamp: CMTime) {
        guard enabled else { return }
        if !forceKeyframe, lastEncodedTimestamp.isValid {
            let elapsed = CMTimeGetSeconds(CMTimeSubtract(timestamp, lastEncodedTimestamp))
            if elapsed.isFinite && elapsed >= 0 && elapsed < 1.0 / Double(maxFps) { return }
        }
        guard ensureSession(pixel), let session else { return }
        let currentGeneration = lockedGeneration()
        let context = RemoteVideoEncodeContext(generation: currentGeneration, submittedAt: DispatchTime.now().uptimeNanoseconds)
        let contextPointer = Unmanaged.passRetained(context).toOpaque()
        metricsLock.lock()
        pendingFrames += 1
        statsSequence &+= 1
        metricsLock.unlock()
        let properties: CFDictionary? = forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        let result = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixel,
            presentationTimeStamp: timestamp,
            duration: .invalid,
            frameProperties: properties,
            sourceFrameRefcon: contextPointer,
            infoFlagsOut: nil
        )
        guard result == noErr else {
            Unmanaged<RemoteVideoEncodeContext>.fromOpaque(contextPointer).release()
            finish(context: context, status: result, sample: nil)
            return
        }
        forceKeyframe = false
        lastEncodedTimestamp = timestamp
    }

    private func ensureSession(_ pixel: CVPixelBuffer) -> Bool {
        if session != nil { return true }
        var created: VTCompressionSession?
        let result = VTCompressionSessionCreate(
            allocator: nil,
            width: Int32(CVPixelBufferGetWidth(pixel)),
            height: Int32(CVPixelBufferGetHeight(pixel)),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: remoteVideoOutputCallback,
            refcon: nil,
            compressionSessionOut: &created
        )
        guard result == noErr, let created else { reportFailure("VideoToolbox session create failed (\(result))"); return false }
        let properties: [(CFString, CFTypeRef)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
            (kVTCompressionPropertyKey_ProfileLevel, profile.videoToolboxValue),
            (kVTCompressionPropertyKey_AverageBitRate, bitRate as CFNumber),
            (kVTCompressionPropertyKey_ExpectedFrameRate, maxFps as CFNumber),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, 20 as CFNumber),
        ]
        for (key, value) in properties {
            let status = VTSessionSetProperty(created, key: key, value: value)
            if status != noErr {
                VTCompressionSessionInvalidate(created)
                reportFailure("VideoToolbox \(profile.rawValue) configuration failed (\(status))")
                return false
            }
        }
        let prepare = VTCompressionSessionPrepareToEncodeFrames(created)
        guard prepare == noErr else {
            VTCompressionSessionInvalidate(created)
            reportFailure("VideoToolbox \(profile.rawValue) prepare failed (\(prepare))")
            return false
        }
        session = created
        forceKeyframe = true
        return true
    }

    fileprivate func finish(context: RemoteVideoEncodeContext, status: OSStatus, sample: CMSampleBuffer?) {
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - context.submittedAt) / 1_000_000
        metricsLock.lock()
        let current = context.generation == generation
        if current {
            pendingFrames = max(0, pendingFrames - 1)
            encodeLatencyMs = encodeLatencyMs == 0 ? elapsed : encodeLatencyMs * 0.8 + elapsed * 0.2
            if status != noErr || sample == nil || !(sample.map(CMSampleBufferDataIsReady) ?? false) { droppedSinceSnapshot += 1 }
            statsSequence &+= 1
        }
        metricsLock.unlock()
        guard current else { return }
        guard status == noErr, let sample, CMSampleBufferDataIsReady(sample) else {
            reportFailure("VideoToolbox encode failed (\(status))", countDrop: false)
            return
        }
        emit(sample)
    }

    private func emit(_ sample: CMSampleBuffer) {
        guard let format = CMSampleBufferGetFormatDescription(sample), let block = CMSampleBufferGetDataBuffer(sample) else { recordDrop(); return }
        var nals: [Data] = []
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
        let key = attachments?.first?[kCMSampleAttachmentKey_NotSync as String] as? Bool != true
        if key {
            for index in 0..<2 {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer {
                    nals.append(Data(bytes: pointer, count: size))
                }
            }
        }
        let size = CMBlockBufferGetDataLength(block)
        var data = Data(count: size)
        let copied = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: size, destination: $0.baseAddress!) }
        guard copied == kCMBlockBufferNoErr else { recordDrop(); return }
        var offset = 0
        while offset + 4 <= size {
            let length = data[offset..<offset+4].reduce(0) { ($0 << 8) | Int($1) }; offset += 4
            guard length > 0, offset + length <= size else { recordDrop(); return }
            nals.append(Data(data[offset..<offset+length])); offset += length
        }
        sendVideo(timestamp: CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)), nals: nals, key: key)
    }

    private func lockedGeneration() -> UInt64 {
        metricsLock.lock(); defer { metricsLock.unlock() }
        return generation
    }
    private func recordDrop() {
        metricsLock.lock(); droppedSinceSnapshot += 1; statsSequence &+= 1; metricsLock.unlock()
    }
    private func reportFailure(_ message: String, countDrop: Bool = true) {
        if countDrop { recordDrop() }
        DispatchQueue.main.async { self.onError?(message) }
    }
}

private let remoteVideoOutputCallback: VTCompressionOutputCallback = { _, sourceFrameRefcon, status, _, sample in
    guard let sourceFrameRefcon else { return }
    let context = Unmanaged<RemoteVideoEncodeContext>.fromOpaque(sourceFrameRefcon).takeRetainedValue()
    remoteVideoEncoder.finish(context: context, status: status, sample: sample)
}

let remoteVideoEncoder = RemoteVideoEncoder()
