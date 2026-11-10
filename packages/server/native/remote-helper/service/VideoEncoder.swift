import Foundation
import VideoToolbox
import CoreMedia

enum RemoteVideoQuality: String, CaseIterable {
    case smooth, hd, original
    var bitRate: Int { switch self { case .smooth: return 2_000_000; case .hd: return 8_000_000; case .original: return 20_000_000 } }
    var maxEdge: Double? { switch self { case .smooth: return 1280; case .hd: return 2560; case .original: return nil } }
    func dimensions(width: Int, height: Int, receiverMaxEdge: Int = 0) -> (Int, Int) {
        let limit = min(maxEdge ?? Double(max(width, height)), receiverMaxEdge > 0 ? Double(receiverMaxEdge) : Double(max(width, height)))
        let ratio = min(1, limit / Double(max(1, max(width, height))))
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

struct RemoteVideoContentVersion: Equatable {
    let epoch: Int
    let revision: Int
}

private struct RemoteVideoFrameOffer {
    let pixel: CVPixelBuffer
    let timestamp: CMTime
    let contentVersion: RemoteVideoContentVersion
}

final class RemoteVideoEncoder {
    var enabled = false
    var bitRate = RemoteVideoQuality.hd.bitRate
    var maxFps = 30
    var keyFrameInterval = 60
    var profile = RemoteH264Profile.baseline
    var lastEncodedTimestamp = CMTime.invalid
    var forceKeyframe = true
    var onError: ((String) -> Void)?
    var onSubmitted: ((CVPixelBuffer, CMTime, RemoteVideoContentVersion) -> Void)?
    var onOutput: (Double, [Data], Bool) -> Void = { sendVideo(timestamp: $0, nals: $1, key: $2) }
    private var maxPendingFrames = 1
    private var latestOffer: RemoteVideoFrameOffer?
    private var drainWork: DispatchWorkItem?
    private var lastSubmittedAt: UInt64 = 0
    private var coalescedFrames = 0

    private let compression: RemoteVideoCompressionPort
    private let timeoutSeconds: TimeInterval
    private var jobs: [UInt64: (startedAt: UInt64, deadline: DispatchWorkItem)] = [:]
    private var jobSequence: UInt64 = 0
    private var offeredTimestamp = CMTime.invalid
    private var offeredDimensions: (Int, Int)?

    init(compression: RemoteVideoCompressionPort = VideoToolboxCompression(), timeoutSeconds: TimeInterval = 3) {
        self.compression = compression; self.timeoutSeconds = timeoutSeconds
    }

    private var generation: UInt64 = 0
    private var pendingFrames = 0
    private var encodeLatencyMs = 0.0
    private var droppedSinceSnapshot = 0
    private var statsSequence: UInt64 = 0
    private var lastActivityAt = Date().timeIntervalSince1970 * 1000
    private var activity = "motion"
    private var activityConfidence = 0.5

    func start(profile: RemoteH264Profile, bitRate: Int, maxFps: Int, maxPendingFrames: Int = 1, keyFrameInterval: Int = 60) {
        self.profile = profile
        self.bitRate = bitRate
        self.maxFps = maxFps
        self.keyFrameInterval = min(120, max(5, keyFrameInterval))
        self.maxPendingFrames = min(2, max(1, maxPendingFrames))
        enabled = true
        reset()
    }

    func setTuning(bitRate: Int, maxFps: Int, maxPendingFrames: Int = 1, keyFrameInterval: Int = 60) {
        self.bitRate = bitRate
        self.maxFps = maxFps
        self.keyFrameInterval = min(120, max(5, keyFrameInterval))
        self.maxPendingFrames = min(2, max(1, maxPendingFrames))
        drain()
    }

    func reset() {
        drainWork?.cancel(); drainWork = nil; latestOffer = nil
        lastSubmittedAt = 0; coalescedFrames = 0
        generation &+= 1
        for job in jobs.values { job.deadline.cancel() }
        jobs.removeAll(); pendingFrames = 0
        encodeLatencyMs = 0; droppedSinceSnapshot = 0; statsSequence &+= 1
        compression.invalidate()
        offeredTimestamp = .invalid; offeredDimensions = nil
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
        activity = next.0
        activityConfidence = next.1
        lastActivityAt = now
        statsSequence &+= 1
    }

    func stats() -> [String: Any] {
        let now = Date().timeIntervalSince1970 * 1000
        if now - lastActivityAt >= 3_000 {
            activity = "idle"
            activityConfidence = 0.95
        }
        let result: [String: Any] = [
            "pendingFrames": pendingFrames,
            "queuedFrames": latestOffer == nil ? 0 : 1,
            "coalescedFrames": coalescedFrames,
            "admissionLimit": maxPendingFrames,
            "encodeLatencyMs": encodeLatencyMs,
            "droppedFrames": droppedSinceSnapshot,
            "sequence": statsSequence,
            "sampledAt": now,
            "activity": activity,
            "activityConfidence": activityConfidence,
            "profile": profile.rawValue,
        ]
        droppedSinceSnapshot = 0
        coalescedFrames = 0
        return result
    }

    func encode(_ pixel: CVPixelBuffer, timestamp: CMTime, contentVersion: RemoteVideoContentVersion) {
        guard enabled, timestamp.isValid, CMTimeGetSeconds(timestamp).isFinite, CMTimeGetSeconds(timestamp) >= 0 else { return }
        let size = (CVPixelBufferGetWidth(pixel), CVPixelBufferGetHeight(pixel))
        if let previous = offeredDimensions, previous != size { reset() }
        offeredDimensions = size
        if latestOffer != nil { coalescedFrames += 1 }
        latestOffer = RemoteVideoFrameOffer(pixel: pixel, timestamp: timestamp, contentVersion: contentVersion)
        drain()
    }

    /// Admission and callbacks are main-owned; the compression port owns all codec work.
    private func drain() {
        drainWork?.cancel(); drainWork = nil
        guard enabled, let offer = latestOffer else { return }
        let pending = pendingFrames
        guard pending < maxPendingFrames else { return }
        let now = DispatchTime.now().uptimeNanoseconds
        let interval = UInt64(1_000_000_000 / max(1, maxFps))
        if lastSubmittedAt > 0 && now - lastSubmittedAt < interval {
            let token = lockedGeneration()
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.lockedGeneration() == token else { return }
                self.drain()
            }
            drainWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(interval - (now - lastSubmittedAt))), execute: work)
            return
        }
        latestOffer = nil
        let timestamp = offeredTimestamp.isValid && CMTimeCompare(offer.timestamp, offeredTimestamp) <= 0
            ? CMTimeAdd(offeredTimestamp, CMTime(value: 1, timescale: 90_000)) : offer.timestamp
        offeredTimestamp = timestamp
        let token = generation
        jobSequence &+= 1; let job = jobSequence
        let startedAt = DispatchTime.now().uptimeNanoseconds
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, self.generation == token, self.jobs[job] != nil else { return }
            self.enabled = false; self.reset()
            self.onError?("VideoToolbox 编码超时，已停止视频；桌面输入仍可用")
        }
        jobs[job] = (startedAt, deadline)
        pendingFrames += 1; statsSequence &+= 1
        let settings = RemoteVideoCompressionSettings(profile: profile, bitRate: bitRate,
            maxFps: maxFps, keyFrameInterval: keyFrameInterval)
        let keyframe = forceKeyframe; forceKeyframe = false; lastSubmittedAt = now
        DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSeconds, execute: deadline)
        compression.submit(offer.pixel, timestamp: timestamp, settings: settings, forceKeyframe: keyframe,
            submitted: { [weak self] status in
                guard let self, self.generation == token, self.jobs[job] != nil else { return }
                if status != noErr { self.finish(job: job, generation: token, status: status, sample: nil); return }
                self.lastEncodedTimestamp = timestamp
                self.onSubmitted?(offer.pixel, timestamp, offer.contentVersion)
            }, completed: { [weak self] status, sample in
                self?.finish(job: job, generation: token, status: status, sample: sample)
            })
    }

    private func finish(job: UInt64, generation token: UInt64, status: OSStatus, sample: CMSampleBuffer?) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard generation == token, let record = jobs.removeValue(forKey: job) else { return }
        record.deadline.cancel(); pendingFrames = max(0, pendingFrames - 1)
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - record.startedAt) / 1_000_000
        encodeLatencyMs = encodeLatencyMs == 0 ? elapsed : encodeLatencyMs * 0.8 + elapsed * 0.2
        statsSequence &+= 1
        if status == noErr, let sample, CMSampleBufferDataIsReady(sample) { emit(sample) }
        else {
            recordDrop(); enabled = false; reset()
            onError?("VideoToolbox encode failed (\(status))")
        }
        drain()
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
        onOutput(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)), nals, key)
    }

    private func lockedGeneration() -> UInt64 { generation }
    private func recordDrop() { droppedSinceSnapshot += 1; statsSequence &+= 1 }

    static func transitionSelfTest() {
        let encoder = RemoteVideoEncoder()
        var outputs = 0, failures: [String] = []
        encoder.onOutput = { _, nals, _ in precondition(!nals.isEmpty); outputs += 1 }
        encoder.onError = { failures.append($0) }
        var revision = 0
        for profile in RemoteH264Profile.allCases {
            encoder.start(profile: profile, bitRate: 8_000_000, maxFps: 30)
            for _ in 0..<4 {
                for (width, height) in [(1280, 534), (2560, 1070), (3440, 1440), (2560, 1070)] {
                    var buffer: CVPixelBuffer?
                    let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
                    precondition(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attrs, &buffer) == kCVReturnSuccess)
                    let pixel = buffer!; CVPixelBufferLockBaseAddress(pixel, [])
                    memset(CVPixelBufferGetBaseAddress(pixel)!, Int32(revision % 255), CVPixelBufferGetDataSize(pixel))
                    CVPixelBufferUnlockBaseAddress(pixel, [])
                    revision += 1; let target = outputs + 1
                    encoder.encode(pixel, timestamp: CMTime(value: Int64(revision), timescale: 30),
                        contentVersion: RemoteVideoContentVersion(epoch: 1, revision: revision))
                    let end = Date().addingTimeInterval(4)
                    while outputs < target && failures.isEmpty && Date() < end {
                        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
                    }
                    precondition(outputs == target && failures.isEmpty, "Transition failed: \(profile) \(width)x\(height): \(failures)")
                    precondition(encoder.stats()["pendingFrames"] as! Int == 0)
                }
            }
            encoder.stop()
        }
        print("compression transition self-test passed: \(outputs) actual High/Baseline frames, 1280/2560/3440 resolution transitions")
    }

    static func admissionSelfTest() {
        let codec = RemoteAdmissionTestCompression()
        let encoder = RemoteVideoEncoder(compression: codec)
        var buffer: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess)
        let pixel = buffer!
        CVPixelBufferLockBaseAddress(pixel, [])
        memset(CVPixelBufferGetBaseAddress(pixel)!, 255, CVPixelBufferGetDataSize(pixel))
        CVPixelBufferUnlockBaseAddress(pixel, [])
        var accepted: [Int] = [], errors: [String] = []
        encoder.onOutput = { _, _, _ in }
        encoder.onError = { errors.append($0) }
        encoder.onSubmitted = { _, _, version in accepted.append(version.revision) }
        encoder.start(profile: .baseline, bitRate: 1_000_000, maxFps: 5, maxPendingFrames: 1)
        for revision in 1...50 {
            encoder.encode(pixel, timestamp: CMTime(value: Int64(revision), timescale: 30),
                contentVersion: RemoteVideoContentVersion(epoch: 1, revision: revision))
            let stats = encoder.stats()
            precondition((stats["pendingFrames"] as! Int) <= 1 && (stats["queuedFrames"] as! Int) <= 1)
            precondition(stats["droppedFrames"] as! Int == 0)
        }
        precondition(accepted == [1])
        codec.completeOne()
        encoder.forceKeyframe = true
        encoder.setTuning(bitRate: 1_000_000, maxFps: 30, maxPendingFrames: 2)
        let deadline = Date().addingTimeInterval(3)
        while accepted.last != 50 && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        precondition(accepted == [1, 50] && errors.isEmpty)
        precondition(!encoder.forceKeyframe)
        codec.completeOne()
        encoder.encode(pixel, timestamp: CMTime(value: 51, timescale: 30), contentVersion: RemoteVideoContentVersion(epoch: 1, revision: 51))
        encoder.stop()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        precondition(accepted == [1, 50])
        precondition(encoder.stats()["queuedFrames"] as! Int == 0)

        // A late receipt from an old resolution cannot become current output.
        let oldSubmission = codec.submissions.last!
        encoder.start(profile: .high, bitRate: 8_000_000, maxFps: 30)
        oldSubmission.submitted(noErr); oldSubmission.completed(kVTInvalidSessionErr, nil)
        precondition(errors.isEmpty && encoder.stats()["pendingFrames"] as! Int == 0)
        // A blocked codec does not block main/control, and expires its bounded work.
        let blocked = RemoteVideoEncoder(compression: RemoteAdmissionTestCompression(), timeoutSeconds: 0.05)
        var timedOut = false; blocked.onError = { _ in timedOut = true }
        blocked.start(profile: .high, bitRate: 8_000_000, maxFps: 30)
        blocked.encode(pixel, timestamp: CMTime(value: 1, timescale: 30), contentVersion: RemoteVideoContentVersion(epoch: 1, revision: 1))
        let timeout = Date().addingTimeInterval(0.5)
        while !timedOut && Date() < timeout { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        precondition(timedOut && !blocked.enabled && blocked.stats()["pendingFrames"] as! Int == 0)

        let capture = RemoteCompoundCapture()
        var metadata: [[String: Any]] = []
        capture.onMetadata = { metadata.append($0) }
        capture.configure(true)
        capture.noteChange(pixel, timestamp: 1, dirtyRects: nil)
        let old = capture.contentVersion
        var changedBuffer: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_32BGRA, nil, &changedBuffer) == kCVReturnSuccess)
        let changed = changedBuffer!
        CVPixelBufferLockBaseAddress(changed, [])
        memset(CVPixelBufferGetBaseAddress(changed)!, 0, CVPixelBufferGetDataSize(changed))
        CVPixelBufferUnlockBaseAddress(changed, [])
        capture.noteChange(changed, timestamp: 2, dirtyRects: nil)
        capture.noteEncoded(pixel, timestamp: 1, contentVersion: old)
        precondition(!metadata.contains { $0["kind"] as? String == "frame" })
        capture.noteEncoded(changed, timestamp: 2, contentVersion: capture.contentVersion)
        precondition(metadata.last?["kind"] as? String == "frame")
        print("encode admission self-test passed: latest=50, bounded pending/held frames, stale content rejected")
    }
}

let remoteVideoEncoder = RemoteVideoEncoder()

private final class RemoteAdmissionTestCompression: RemoteVideoCompressionPort {
    struct Submission { let submitted: (OSStatus) -> Void; let completed: (OSStatus, CMSampleBuffer?) -> Void }
    var submissions: [Submission] = []
    func submit(_ pixel: CVPixelBuffer, timestamp: CMTime, settings: RemoteVideoCompressionSettings,
                forceKeyframe: Bool, submitted: @escaping (OSStatus) -> Void,
                completed: @escaping (OSStatus, CMSampleBuffer?) -> Void) {
        submissions.append(Submission(submitted: submitted, completed: completed)); submitted(noErr)
    }
    func invalidate() {}
    func completeOne() {
        guard let value = submissions.first else { return }
        // A ready but empty sample exercises admission without synthesizing codec output.
        var sample: CMSampleBuffer?
        precondition(CMSampleBufferCreate(allocator: nil, dataBuffer: nil, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: nil, sampleCount: 0,
            sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 0,
            sampleSizeArray: nil, sampleBufferOut: &sample) == noErr)
        value.completed(noErr, sample)
    }
}
