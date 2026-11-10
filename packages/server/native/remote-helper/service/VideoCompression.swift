import Foundation
import VideoToolbox
import CoreMedia
import CoreVideo

struct RemoteVideoCompressionSettings: Equatable {
    let profile: RemoteH264Profile
    let bitRate: Int
    let maxFps: Int
    let keyFrameInterval: Int
}

/// The admission coordinator never waits for a codec or the driver's XPC service.
protocol RemoteVideoCompressionPort: AnyObject {
    func submit(_ pixel: CVPixelBuffer, timestamp: CMTime, settings: RemoteVideoCompressionSettings,
                forceKeyframe: Bool, submitted: @escaping (OSStatus) -> Void,
                completed: @escaping (OSStatus, CMSampleBuffer?) -> Void)
    func invalidate()
}

private final class RemoteVideoCompressionCallback {
    let receive: (OSStatus, CMSampleBuffer?) -> Void
    init(_ receive: @escaping (OSStatus, CMSampleBuffer?) -> Void) { self.receive = receive }
}

private let remoteCompressionOutput: VTCompressionOutputCallback = { _, pointer, status, _, sample in
    guard let pointer else { return }
    let callback = Unmanaged<RemoteVideoCompressionCallback>.fromOpaque(pointer).takeRetainedValue()
    callback.receive(status, sample)
}

/// All session creation, property updates, encoding and disposal belong to this queue.
final class VideoToolboxCompression: RemoteVideoCompressionPort {
    private let queue = DispatchQueue(label: "agentroam.video.compression", qos: .userInteractive)
    private let cancellation = NSLock()
    private var generation: UInt64 = 0
    private struct Request {
        let pixel: CVPixelBuffer; let timestamp: CMTime; let settings: RemoteVideoCompressionSettings
        let forceKeyframe: Bool; let generation: UInt64
        let submitted: (OSStatus) -> Void; let completed: (OSStatus, CMSampleBuffer?) -> Void
    }
    private var requests: [Request] = []
    private var workerScheduled = false
    private var disposalRequested = false
    private var session: VTCompressionSession?
    private var dimensions = (0, 0)
    private var applied: RemoteVideoCompressionSettings?

    func invalidate() {
        cancellation.lock()
        generation &+= 1; requests.removeAll(); disposalRequested = true
        scheduleLocked(); cancellation.unlock()
    }

    private func currentGeneration() -> UInt64 {
        cancellation.lock(); defer { cancellation.unlock() }; return generation
    }

    func submit(_ pixel: CVPixelBuffer, timestamp: CMTime, settings: RemoteVideoCompressionSettings,
                forceKeyframe: Bool, submitted: @escaping (OSStatus) -> Void,
                completed: @escaping (OSStatus, CMSampleBuffer?) -> Void) {
        cancellation.lock()
        guard requests.count < 2 else {
            cancellation.unlock(); DispatchQueue.main.async { submitted(kVTVideoEncoderNotAvailableNowErr) }; return
        }
        requests.append(Request(pixel: pixel, timestamp: timestamp, settings: settings,
            forceKeyframe: forceKeyframe, generation: generation, submitted: submitted, completed: completed))
        scheduleLocked(); cancellation.unlock()
    }

    private func scheduleLocked() {
        guard !workerScheduled else { return }
        workerScheduled = true; queue.async { self.pump() }
    }

    private func pump() {
        dispatchPrecondition(condition: .onQueue(queue))
        while true {
            cancellation.lock()
            if disposalRequested {
                disposalRequested = false; cancellation.unlock(); dispose(); continue
            }
            guard !requests.isEmpty else {
                workerScheduled = false; cancellation.unlock(); return
            }
            let request = requests.removeFirst(); cancellation.unlock()
            guard request.generation == currentGeneration() else { continue }
            encode(request)
        }
    }

    private func encode(_ request: Request) {
        let ready = prepare(request.pixel, settings: request.settings)
        guard request.generation == currentGeneration() else { return }
        guard ready == noErr, let session else {
            DispatchQueue.main.async { request.submitted(ready) }; return
        }
        let callback = RemoteVideoCompressionCallback { [queue] status, sample in
            // A codec may call back inline from EncodeFrame. Hopping through
            // its serial queue orders submission receipt before completion.
            queue.async { DispatchQueue.main.async { request.completed(status, sample) } }
        }
        let pointer = Unmanaged.passRetained(callback).toOpaque()
        let options: CFDictionary? = request.forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: request.pixel,
            presentationTimeStamp: request.timestamp, duration: .invalid, frameProperties: options,
            sourceFrameRefcon: pointer, infoFlagsOut: nil)
        if status != noErr { Unmanaged<RemoteVideoCompressionCallback>.fromOpaque(pointer).release() }
        DispatchQueue.main.async { request.submitted(status) }
    }

    private func prepare(_ pixel: CVPixelBuffer, settings: RemoteVideoCompressionSettings) -> OSStatus {
        dispatchPrecondition(condition: .onQueue(queue))
        let size = (CVPixelBufferGetWidth(pixel), CVPixelBufferGetHeight(pixel))
        if session != nil && (size != dimensions || applied?.profile != settings.profile) { dispose() }
        if let session {
            guard applied != settings else { return noErr }
            let updates: [(CFString, Int, Int?)] = [
                (kVTCompressionPropertyKey_AverageBitRate, settings.bitRate, applied?.bitRate),
                (kVTCompressionPropertyKey_ExpectedFrameRate, settings.maxFps, applied?.maxFps),
                (kVTCompressionPropertyKey_MaxKeyFrameInterval, settings.keyFrameInterval, applied?.keyFrameInterval),
            ]
            for (key, value, previous) in updates where previous != value {
                let status = VTSessionSetProperty(session, key: key, value: value as CFNumber)
                if status != noErr { return status }
            }
            applied = settings; return noErr
        }
        var created: VTCompressionSession?
        var specification: [CFString: Any] = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true]
        // Apple's low-latency mode only supports High; Baseline remains a real fallback.
        if settings.profile == .high { specification[kVTVideoEncoderSpecification_EnableLowLatencyRateControl] = true }
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(size.0), height: Int32(size.1),
            codecType: kCMVideoCodecType_H264, encoderSpecification: specification as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: remoteCompressionOutput, refcon: nil, compressionSessionOut: &created)
        guard status == noErr, let created else { return status == noErr ? kVTInvalidSessionErr : status }
        for (key, value) in properties(settings) {
            let configured = VTSessionSetProperty(created, key: key, value: value)
            if configured != noErr { VTCompressionSessionInvalidate(created); return configured }
        }
        let ready = VTCompressionSessionPrepareToEncodeFrames(created)
        guard ready == noErr else { VTCompressionSessionInvalidate(created); return ready }
        session = created; dimensions = size; applied = settings; return noErr
    }

    private func properties(_ settings: RemoteVideoCompressionSettings) -> [(CFString, CFTypeRef)] {
        [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
            (kVTCompressionPropertyKey_ProfileLevel, settings.profile.videoToolboxValue),
            (kVTCompressionPropertyKey_AverageBitRate, settings.bitRate as CFNumber),
            (kVTCompressionPropertyKey_ExpectedFrameRate, settings.maxFps as CFNumber),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, settings.keyFrameInterval as CFNumber),
        ]
    }

    private func dispose() {
        dispatchPrecondition(condition: .onQueue(queue))
        // Frames from a replaced resolution are obsolete. CompleteFrames would
        // synchronously drain them and can wait on the same remote codec service.
        if let session { VTCompressionSessionInvalidate(session) }
        session = nil; applied = nil; dimensions = (0, 0)
    }
}
