import AVFoundation
import CoreMedia
import Foundation

final class RemoteAudioPlayback {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var started = false
    private var sampleRate: Double?
    private var channels: UInt32?

    init() {
        engine.attach(player)
    }

    func play(base64: String?, sampleRate: Double?, channels: UInt32?) throws {
        guard let base64, let data = Data(base64Encoded: base64), !data.isEmpty,
              data.count <= 48_000, let sampleRate, (8_000...48_000).contains(sampleRate),
              let channels, (1...2).contains(channels), data.count % (Int(channels) * 2) == 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: AVAudioChannelCount(channels), interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / (Int(channels) * 2))) else {
            throw NSError(domain: "AgentRoamAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "无效的麦克风音频帧"])
        }
        buffer.frameLength = buffer.frameCapacity
        guard let destinations = buffer.floatChannelData else {
            throw NSError(domain: "AgentRoamAudio", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法创建麦克风播放缓冲区"])
        }
        data.withUnsafeBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            for frame in 0..<Int(buffer.frameLength) {
                for channel in 0..<Int(channels) {
                    let offset = (frame * Int(channels) + channel) * 2
                    let bits = UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
                    destinations[channel][frame] = Float(Int16(bitPattern: bits)) / 32768
                }
            }
        }
        if started && (self.sampleRate != sampleRate || self.channels != channels) { stop() }
        if !started {
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            try engine.start()
            player.play()
            started = true
            self.sampleRate = sampleRate
            self.channels = channels
        }
        player.scheduleBuffer(buffer)
    }

    func stop() {
        player.stop()
        engine.stop()
        engine.disconnectNodeOutput(player)
        engine.reset()
        started = false
        sampleRate = nil
        channels = nil
    }
}

func systemAudioEvent(_ sampleBuffer: CMSampleBuffer, sequence: Int) -> [String: Any]? {
    guard sampleBuffer.isValid, let description = sampleBuffer.formatDescription,
          let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { return nil }
    let channels = Int(format.mChannelsPerFrame)
    let frames = CMSampleBufferGetNumSamples(sampleBuffer)
    guard (1...2).contains(channels), frames > 0, format.mFormatID == kAudioFormatLinearPCM else { return nil }

    var required = 0
    var blockBuffer: CMBlockBuffer?
    let flags = kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: &required,
        bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault, flags: UInt32(flags), blockBufferOut: &blockBuffer) == noErr else { return nil }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: required, alignment: 16)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: nil,
        bufferListOut: list, bufferListSize: required, blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault, flags: UInt32(flags), blockBufferOut: &blockBuffer) == noErr else { return nil }

    let buffers = UnsafeMutableAudioBufferListPointer(list)
    let nonInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    let isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0 && format.mBitsPerChannel == 32
    let isInt16 = !isFloat && format.mBitsPerChannel == 16
    guard isFloat || isInt16 else { return nil }
    var output = Data(count: frames * channels * 2)
    output.withUnsafeMutableBytes { destination in
        let values = destination.bindMemory(to: Int16.self)
        for frame in 0..<frames {
            for channel in 0..<channels {
                let bufferIndex = nonInterleaved ? channel : 0
                guard bufferIndex < buffers.count, let source = buffers[bufferIndex].mData else { continue }
                let sampleIndex = nonInterleaved ? frame : frame * channels + channel
                if isFloat {
                    let value = source.assumingMemoryBound(to: Float.self)[sampleIndex]
                    values[frame * channels + channel] = Int16(max(-32768, min(32767, Int(value * 32767))))
                } else {
                    values[frame * channels + channel] = source.assumingMemoryBound(to: Int16.self)[sampleIndex]
                }
            }
        }
    }
    return ["event": "audio", "sequence": sequence, "sampleRate": Int(format.mSampleRate), "channels": channels, "data": output.base64EncodedString()]
}
