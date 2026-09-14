import AppKit
import CoreGraphics
import CoreImage
import ScreenCaptureKit

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
