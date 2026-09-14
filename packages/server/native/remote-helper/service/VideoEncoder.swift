import Foundation
import VideoToolbox
import CoreMedia

final class RemoteVideoEncoder {
    var session: VTCompressionSession?
    var enabled = false
    var forceKeyframe = true
    func stop() {
        enabled = false
        if let session { VTCompressionSessionInvalidate(session) }
        session = nil
    }
    func encode(_ pixel: CVPixelBuffer, timestamp: CMTime) {
        guard enabled else { return }
        if session == nil {
            let result = VTCompressionSessionCreate(allocator: nil, width: Int32(CVPixelBufferGetWidth(pixel)), height: Int32(CVPixelBufferGetHeight(pixel)), codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: { _, _, status, _, sample in
                guard status == noErr, let sample, CMSampleBufferDataIsReady(sample), let format = CMSampleBufferGetFormatDescription(sample), let block = CMSampleBufferGetDataBuffer(sample) else { return }
                var nals: [String] = []
                let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
                let key = attachments?.first?[kCMSampleAttachmentKey_NotSync as String] as? Bool != true
                if key {
                    for index in 0..<2 {
                        var pointer: UnsafePointer<UInt8>?
                        var size = 0
                        if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer { nals.append(Data(bytes: pointer, count: size).base64EncodedString()) }
                    }
                }
                let size = CMBlockBufferGetDataLength(block)
                var data = Data(count: size)
                let copied = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: size, destination: $0.baseAddress!) }
                guard copied == kCMBlockBufferNoErr else { return }
                var offset = 0
                while offset + 4 <= size {
                    let length = data[offset..<offset+4].reduce(0) { ($0 << 8) | Int($1) }; offset += 4
                    guard length > 0, offset + length <= size else { return }
                    nals.append(data[offset..<offset+length].base64EncodedString()); offset += length
                }
                respond(nil, ["event": "video", "nals": nals, "timestamp": CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))])
            }, refcon: nil, compressionSessionOut: &session)
            guard result == noErr, let session else { return }
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_3_1)
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: 2_000_000 as CFNumber)
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 20 as CFNumber)
            VTCompressionSessionPrepareToEncodeFrames(session)
            forceKeyframe = true
        }
        guard let session else { return }
        let properties: CFDictionary? = forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        forceKeyframe = false
        VTCompressionSessionEncodeFrame(session, imageBuffer: pixel, presentationTimeStamp: timestamp, duration: .invalid, frameProperties: properties, sourceFrameRefcon: nil, infoFlagsOut: nil)
    }
}
let remoteVideoEncoder = RemoteVideoEncoder()
