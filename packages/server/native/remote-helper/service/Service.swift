import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func lockedScreen() -> Bool? {
    guard let session=CGSessionCopyCurrentDictionary() as? [String:Any] else { return nil }
    return (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
}
func diagnostic() -> [String:Any] {
    ["screenCapture":CGPreflightScreenCaptureAccess(),"accessibility":AXIsProcessTrusted(),"locked":lockedScreen() as Any? ?? NSNull(),"pid":ProcessInfo.processInfo.processIdentifier,"bundleId":Bundle.main.bundleIdentifier ?? "unknown"]
}
func printJSON(_ value:[String:Any]) {
    if let bytes=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]),let text=String(data:bytes,encoding:.utf8) { print(text) }
}
struct ServiceConfig: Decodable { let endpoint:String;let producerToken:String }

@MainActor final class RemoteDesktop {
    private let configPath:URL
    private let statusPath:URL
    private let input=RemoteInput()
    private var socket:URLSessionWebSocketTask?
    private var capture:DesktopCapture?
    private var generation=UUID().uuidString
    private var locked=lockedScreen()
    private var connected=false
    private var controlled=false
    private var controlUntil=Date.distantPast
    private var captureEpoch=UUID().uuidString
    private var restarting=false
    private var generationStartedAt=ProcessInfo.processInfo.systemUptime
    private var lastPublishedStatus=""
    private var lastFrame=Date.distantPast
    private var frameSequence=0
    private var sendingFrame=false
    private var bounds=CGRect.zero
    private var errorCode:String?
    private var requestID=1
    private var running=true
    private let sessionID="desktop:native"

    init(configPath:URL) { self.configPath=configPath;statusPath=configPath.deletingLastPathComponent().appendingPathComponent("status.json") }
    func run() async {
        Task { while running { await heartbeat();try? await Task.sleep(nanoseconds:1_000_000_000) } }
        while running {
            do {
                let config=try JSONDecoder().decode(ServiceConfig.self,from:Data(contentsOf:configPath))
                guard let endpoint=URL(string:config.endpoint),let host=endpoint.host,
                      endpoint.scheme == "https" || (endpoint.scheme == "http" && ["localhost","127.0.0.1","::1"].contains(host)) else { throw NativeFailure(code:"secure-endpoint-required") }
                var check=URLRequest(url:endpoint.appendingPathComponent("desktop-access/status"));check.timeoutInterval=8
                let (checkData,_)=try await URLSession.shared.data(for:check)
                guard let protection=try JSONSerialization.jsonObject(with:checkData) as? [String:Any],protection["required"] as? Bool == true else { throw NativeFailure(code:"gateway-protection-required") }
                var bootstrap=URLRequest(url:endpoint.appendingPathComponent("api/web-console/bootstrap"));bootstrap.timeoutInterval=10
                bootstrap.setValue("Bearer \(config.producerToken)",forHTTPHeaderField:"Authorization")
                let (data,response)=try await URLSession.shared.data(for:bootstrap)
                guard (response as? HTTPURLResponse)?.statusCode == 200,let body=try JSONSerialization.jsonObject(with:data) as? [String:Any],let nonce=body["wsNonce"] as? String else { throw NativeFailure(code:"gateway-authorization-failed") }
                var address=URLComponents(url:endpoint,resolvingAgainstBaseURL:false)!
                address.scheme=endpoint.scheme == "https" ? "wss" : "ws";address.path="/ws";address.queryItems=[URLQueryItem(name:"nonce",value:nonce)]
                var request=URLRequest(url:address.url!);request.setValue("Bearer \(config.producerToken)",forHTTPHeaderField:"Authorization")
                request.setValue("\(endpoint.scheme!)://\(endpoint.host!)\(endpoint.port.map { ":\($0)" } ?? "")",forHTTPHeaderField:"Origin")
                let transport=URLSession.shared.webSocketTask(with:request);socket=transport;transport.resume()
                try await send(["type":"browser:publish","sessionId":sessionID,"backend":"desktop","title":"本机桌面 · 原生服务","availability":"starting","state":"agent-controlled"])
                connected=true;lastPublishedStatus="";errorCode=nil;generation=UUID().uuidString;generationStartedAt=ProcessInfo.processInfo.systemUptime;lastFrame = .distantPast
                await restartCapture()
                while running,socket === transport {
                    let message=try await transport.receive()
                    let bytes:Data
                    switch message { case .data(let d):bytes=d;case .string(let s):bytes=Data(s.utf8);@unknown default:continue }
                    guard let body=try JSONSerialization.jsonObject(with:bytes) as? [String:Any] else { continue }
                    await receive(body)
                }
            } catch { errorCode=(error as? NativeFailure)?.code ?? "gateway-disconnected" }
            connected=false;controlled=false;input.releaseAll();socket?.cancel(with:.goingAway,reason:nil);socket=nil
            await capture?.stop();capture=nil;writeStatus()
            try? await Task.sleep(nanoseconds:2_000_000_000)
        }
    }
    func stop() { running=false;controlled=false;input.releaseAll();socket?.cancel(with:.goingAway,reason:nil);writeStatus() }
    private func send(_ object:[String:Any]) async throws {
        guard let socket else { throw NativeFailure(code:"gateway-disconnected") }
        var body=object;requestID+=1;body["_req"]=requestID
        let bytes=try JSONSerialization.data(withJSONObject:body)
        try await socket.send(.string(String(decoding:bytes,as:UTF8.self)))
    }
    private func restartCapture() async {
        guard !restarting else { return };restarting=true;defer { restarting=false }
        captureEpoch=UUID().uuidString
        await capture?.stop();capture=nil;lastFrame = .distantPast;input.releaseAll()
        await publishStatus()
        guard CGPreflightScreenCaptureAccess() else { errorCode="screen-recording-required";await publishStatus();return }
        let next=DesktopCapture();let captureID=captureEpoch
        next.onFrame={ [weak self] data,bounds,timestamp in Task { @MainActor in
            guard let self,self.captureEpoch == captureID,timestamp.isFinite,timestamp >= self.generationStartedAt,lockedScreen() == self.locked else { return }
            await self.frame(data,bounds:bounds)
        } }
        next.onUnavailable={ [weak self] in Task { @MainActor in
            guard let self,self.captureEpoch == captureID else { return }
            self.lastFrame = .distantPast;self.errorCode="capture-suspended";self.controlled=false;self.input.releaseAll();await self.publishStatus()
        } }
        next.onFailure={ [weak self] in Task { @MainActor in
            guard let self,self.captureEpoch == captureID else { return }
            self.errorCode="capture-stopped";self.lastFrame = .distantPast;self.controlled=false;self.input.releaseAll()
            let failed=self.capture;self.capture=nil;await failed?.stop();await self.publishStatus()
        } }
        capture=next
        do { try await next.start();errorCode=nil } catch { errorCode="screen-capture-unavailable";capture=nil;await next.stop() }
        await publishStatus()
    }
    private func frame(_ data:Data,bounds:CGRect) async {
        guard connected,!sendingFrame else { return };sendingFrame=true;defer { sendingFrame=false }
        let firstFrame=lastFrame == .distantPast
        self.bounds=bounds;lastFrame=Date();errorCode=nil;frameSequence+=1
        if firstFrame { await publishStatus() }
        do {
            try await send(["type":"browser:frame","sessionId":sessionID,"sequence":frameSequence,"generation":generation,"data":data.base64EncodedString(),"viewport":["width":bounds.width,"height":bounds.height,"deviceScaleFactor":1],"title":"本机桌面 · 原生服务"])
        } catch { errorCode="frame-delivery-failed" }
    }
    private func status() -> [String:Any] {
        var result=diagnostic()
        result["captureBackend"]=capture?.backend as Any? ?? NSNull()
        result["connected"]=connected;result["controlled"]=controlled;result["generation"]=generation
        result["frameReady"]=connected && capture != nil && lastFrame != .distantPast
        result["inputReady"]=(result["frameReady"] as? Bool == true) && AXIsProcessTrusted() && locked != nil
        result["updatedAt"]=Date().timeIntervalSince1970*1000
        result["errorCode"]=errorCode as Any? ?? NSNull()
        return result
    }
    private func writeStatus() {
        guard let data=try? JSONSerialization.data(withJSONObject:status()) else { return }
        try? data.write(to:statusPath,options:.atomic)
        try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:statusPath.path)
    }
    private func publishStatus() async {
        writeStatus()
        var value=status();value.removeValue(forKey:"updatedAt");value.removeValue(forKey:"pid")
        let encoded=(try? JSONSerialization.data(withJSONObject:value,options:.sortedKeys)).map { String(decoding:$0,as:UTF8.self) } ?? ""
        if connected && encoded != lastPublishedStatus {
            do { try await send(["type":"browser:desktop-status","sessionId":sessionID,"status":value]);lastPublishedStatus=encoded } catch {}
        }
    }
    private func heartbeat() async {
        let current=lockedScreen()
        if current != locked {
            locked=current;generation=UUID().uuidString;generationStartedAt=ProcessInfo.processInfo.systemUptime;controlled=false;input.releaseAll()
            // Invalidate the old frame and all control immediately. Only a capture
            // timestamp after this transition may make the new generation ready.
            lastFrame = .distantPast
            await publishStatus();try? await send(["type":"browser:producer-state","sessionId":sessionID,"state":"agent-controlled"])
            // Keep the display stream across locking. macOS may refuse a new
            // SCShareableContent query while LoginWindow owns the screen.
        }
        if controlled && Date()>controlUntil { controlled=false;input.releaseAll();try? await send(["type":"browser:producer-state","sessionId":sessionID,"state":"agent-controlled"]) }
        if connected && capture == nil && CGPreflightScreenCaptureAccess() { await restartCapture() }
        await publishStatus()
    }
    private func receive(_ message:[String:Any]) async {
        let type=message["type"] as? String ?? ""
        if type == "error" { errorCode="gateway-request-rejected";socket?.cancel(with:.policyViolation,reason:nil);return }
        guard message["sessionId"] as? String == sessionID else { return }
        if type == "browser:takeover-requested" {
            guard status()["inputReady"] as? Bool == true else {
                try? await send(["type":"browser:producer-state","sessionId":sessionID,"state":"agent-controlled"]);return
            }
            controlled=true;controlUntil=Date().addingTimeInterval(60)
            try? await send(["type":"browser:producer-state","sessionId":sessionID,"state":"user-controlled"])
        } else if type == "browser:return-requested" {
            controlled=false;input.releaseAll()
            try? await send(["type":"browser:producer-state","sessionId":sessionID,"state":"agent-controlled"])
        } else if type == "browser:input" {
            do {
                guard controlled,Date()<controlUntil,status()["inputReady"] as? Bool == true,lockedScreen()==locked,
                      let command=message["input"] as? [String:Any],command["generation"] as? String == generation,
                      let expiresAt=command["expiresAt"] as? Double,expiresAt >= Date().timeIntervalSince1970*1000,expiresAt <= Date().timeIntervalSince1970*1000+10000 else { throw NativeFailure(code:"stale-control-session") }
                try input.dispatch(command,bounds:bounds);controlUntil=Date().addingTimeInterval(60)
            } catch {
                input.releaseAll()
                try? await send(["type":"browser:input-error","sessionId":sessionID,"code":(error as? NativeFailure)?.code ?? "input-failed"])
            }
        }
    }
}


func runStandaloneService() {
let args=CommandLine.arguments
if args.contains("--diagnose") { printJSON(diagnostic());exit(0) }
let application=NSApplication.shared
application.setActivationPolicy(.accessory)
if args.contains("--request-permissions") {
    _=CGRequestScreenCaptureAccess()
    let options=[kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary
    _=AXIsProcessTrustedWithOptions(options)
    printJSON(diagnostic());exit(0)
}
let defaultConfig=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AgentRoamRemoteDesktop/service.json")
let config:URL
if let index=args.firstIndex(of:"--config"),args.count>index+1 { config=URL(fileURLWithPath:args[index+1]) } else { config=defaultConfig }
Task { @MainActor in
    let runtime=RemoteDesktop(configPath:config)
    let termination=DispatchSource.makeSignalSource(signal:SIGTERM,queue:.main)
    signal(SIGTERM,SIG_IGN)
    termination.setEventHandler { runtime.stop();exit(0) };termination.resume()
    await runtime.run()
    termination.cancel()
}
application.run()

}
