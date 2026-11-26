import AppKit
import CoreGraphics
import CoreImage
import ScreenCaptureKit

struct RemoteScreenSample {
    let pixel: CVPixelBuffer?
    let timestamp: CMTime
    var dirtyRects: [CGRect]?
}

/// ScreenCaptureKit delivers on a dedicated queue. Keep at most one pending
/// change while the main queue owns input, the encoder and compound revisions.
final class RemoteScreenOutput: NSObject, SCStreamOutput {
    private let lock = NSLock()
    private var pending: RemoteScreenSample?
    private let consume: (SCStream, RemoteScreenSample) -> Void

    init(consume: @escaping (SCStream, RemoteScreenSample) -> Void) { self.consume = consume }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid,
              let info = (CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              let status = info[.status] as? Int else { return }
        let pixel = CMSampleBufferGetImageBuffer(buffer)
        guard status == SCFrameStatus.idle.rawValue || (status == SCFrameStatus.complete.rawValue && pixel != nil) else { return }
        var sample = RemoteScreenSample(pixel: status == SCFrameStatus.idle.rawValue ? nil : pixel,
            timestamp: CMSampleBufferGetPresentationTimeStamp(buffer),
            dirtyRects: (info[.dirtyRects] as? [NSValue])?.map(\.rectValue))
        lock.lock()
        if let previous = pending {
            if sample.pixel != nil {
                // Rectangles only describe the change from the preceding capture.
                if previous.pixel != nil { sample.dirtyRects = nil }
                pending = sample
            }
            lock.unlock()
            return
        }
        pending = sample
        lock.unlock()
        DispatchQueue.main.async {
            self.lock.lock()
            let latest = self.pending
            self.pending = nil
            self.lock.unlock()
            if let latest { self.consume(stream, latest) }
        }
    }
}

final class DesktopCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private(set) var backend="starting"
    private var quartz: UnsafeMutableRawPointer?
    private var stream: SCStream?
    private let queue=DispatchQueue(label:"com.agentroam.remote-desktop.capture")
    private let context=CIContext(options:[.cacheIntermediates:false])
    var onFrame: (@Sendable (Data, CGRect, Double) -> Void)?
    var onUnavailable: (@Sendable () -> Void)?
    var onFailure: (@Sendable () -> Void)?
    private var bounds=CGRect.zero

    func start() async throws {
        let display=CGMainDisplayID()
        bounds=CGDisplayBounds(display)
        let ratio=min(1,1440 / max(1,bounds.width))
        quartz=ARDCreateDisplayStream(display,Int(bounds.width*ratio),Int(bounds.height*ratio),queue) { [weak self] status,time,surface in
            guard let self else { return }
            if status == 1 { return } // Idle: the previous complete frame is still valid.
            if status == 3 { self.onFailure?();return }
            guard status == 0,let surface else { self.onUnavailable?();return }
            self.encode(CIImage(ioSurface:surface),timestamp:ARDHostTimeSeconds(time))
        }
        if let quartz {
            if ARDStartDisplayStream(quartz) == 0 { backend="quartz";return }
            ARDStopDisplayStream(quartz);self.quartz=nil
        }
        backend="screen-capture-kit"
        try await startScreenCaptureKit()
    }
    private func startScreenCaptureKit() async throws {
        let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:false)
        guard let display=content.displays.first(where:{$0.displayID == CGMainDisplayID()}) ?? content.displays.first else { throw NativeFailure(code:"display-unavailable") }
        bounds=CGDisplayBounds(display.displayID)
        let config=SCStreamConfiguration()
        let ratio=min(1,1440 / max(1,bounds.width))
        config.width=Int(bounds.width*ratio);config.height=Int(bounds.height*ratio)
        config.minimumFrameInterval=CMTime(value:1,timescale:4);config.queueDepth=3;config.showsCursor=true
        config.capturesAudio=false;config.pixelFormat=kCVPixelFormatType_32BGRA
        let next=SCStream(filter:SCContentFilter(display:display,excludingWindows:[]),configuration:config,delegate:self)
        try next.addStreamOutput(self,type:.screen,sampleHandlerQueue:queue)
        stream=next;try await next.startCapture()
    }
    func stop() async {
        if let quartz { self.quartz=nil;ARDStopDisplayStream(quartz) }
        let current=stream;stream=nil;try? await current?.stopCapture()
    }
    func stream(_ stream:SCStream,didStopWithError error:Error) {
        let error=error as NSError
        print("capture-stopped domain=\(error.domain) code=\(error.code)")
        onFailure?()
    }
    func stream(_ stream:SCStream,didOutputSampleBuffer sampleBuffer:CMSampleBuffer,of type:SCStreamOutputType) {
        guard type == .screen,sampleBuffer.isValid else { return }
        guard let attachment=CMSampleBufferGetSampleAttachmentsArray(sampleBuffer,createIfNecessary:false) as? [[SCStreamFrameInfo:Any]],let raw=attachment.first?[.status] as? Int else { return }
        if raw == SCFrameStatus.idle.rawValue { return }
        guard raw == SCFrameStatus.complete.rawValue,let pixels=sampleBuffer.imageBuffer else { onUnavailable?();return }
        encode(CIImage(cvPixelBuffer:pixels),timestamp:sampleBuffer.presentationTimeStamp.seconds)
    }
    private func encode(_ image:CIImage,timestamp:Double) {
        guard let jpeg=context.jpegRepresentation(of:image,colorSpace:CGColorSpaceCreateDeviceRGB(),options:[kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption:0.65]),jpeg.count <= 640*1024 else { return }
        onFrame?(jpeg,bounds,timestamp)
    }
}
