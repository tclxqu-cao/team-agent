// Native wake-word listener for macOS (Swift, Speech framework).
// Spawned by the Electron main process so TCC attribution belongs to the
// app (Info.plist carries NSMicrophoneUsageDescription and
// NSSpeechRecognitionUsageDescription).
//
// Protocol (stdout lines):
//   READY           listener up and authorized
//   TEXT <t>        partial transcript (main matches the full wake word)
//   FINAL <t>       final transcript (also allows safe truncated matching)
//   BARGE_IN        sustained speech detected while TTS is playing
//   ERROR <desc>    non-fatal issue; the loop keeps retrying
// Exit codes: 2 speech-auth denied, 3 mic denied

import Foundation
import Speech
import AVFoundation
import Darwin

let localeArg = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "zh-CN"
let recognitionModeArg = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "wake"
let pcmSelfTest = recognitionModeArg == "--pcm-self-test"
let externalAsr = recognitionModeArg.hasPrefix("external-")
let recognitionMode = externalAsr
    ? String(recognitionModeArg.dropFirst("external-".count))
    : recognitionModeArg
let binaryPcmOutput = externalAsr || pcmSelfTest
let pcmOutputQueue = DispatchQueue(label: "customer-agent.voice.pcm-output")

func emit(_ s: String) {
    if binaryPcmOutput {
        FileHandle.standardError.write(Data((s + "\n").utf8))
    } else {
        print(s)
        fflush(stdout)
    }
}

func writePcm(_ data: Data) {
    FileHandle.standardOutput.write(data)
}

func convertTo16kMono(
    _ buffer: AVAudioPCMBuffer,
    converter: AVAudioConverter,
    outputFormat: AVAudioFormat
) -> Data? {
    let ratio = outputFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio) + 32)
    guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
        return nil
    }
    var supplied = false
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
        if supplied {
            inputStatus.pointee = .noDataNow
            return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return buffer
    }
    guard status != .error,
          conversionError == nil,
          output.frameLength > 0,
          let channel = output.floatChannelData?[0] else {
        return nil
    }
    return Data(bytes: channel, count: Int(output.frameLength) * MemoryLayout<Float>.size)
}

func runPcmSelfTest() {
    guard let inputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 48_000,
        channels: 2,
        interleaved: false
    ), let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    ), let converter = AVAudioConverter(from: inputFormat, to: outputFormat),
       let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: 4_800) else {
        emit("ERROR pcm-self-test-format")
        exit(1)
    }
    input.frameLength = 4_800
    for channelIndex in 0..<Int(inputFormat.channelCount) {
        guard let channel = input.floatChannelData?[channelIndex] else { continue }
        for frame in 0..<Int(input.frameLength) {
            channel[frame] = sin(Float(frame) * 2 * Float.pi * 440 / 48_000)
        }
    }
    guard let data = convertTo16kMono(input, converter: converter, outputFormat: outputFormat) else {
        emit("ERROR pcm-self-test-convert")
        exit(1)
    }
    emit("READY pcm-self-test")
    writePcm(data)
}

let wakeBias = [
    "小智", "小志", "小知", "小芝", "小之", "小值", "小纸", "小镇",
    "你好小智", "小智你好", "小智在吗", "小智请回答"
]
let speechPeakThreshold: Float = 0.009
let bargeInSpeechPeakThreshold: Float = 0.10
let bargeInSpeechRmsThreshold: Float = 0.02
let bargeInSustainDuration: TimeInterval = 0.25
let silenceAfterSpeech: TimeInterval = 0.8
let silentSegmentDuration: TimeInterval = 5.0
let maximumSpeechSegmentDuration: TimeInterval = 12.0
var recognizer: SFSpeechRecognizer?
var audioEngine: AVAudioEngine?
var recordingFile: AVAudioFile?
var recordingURL: URL?
var task: SFSpeechRecognitionTask?
var cycle = 0
var tapCount = 0
var resultCount = 0
var peakLevel: Float = 0
var rmsLevel: Float = 0
var segmentStartedAt: TimeInterval = 0
var speechDetected = false
var speechStartedAt: TimeInterval = 0
var lastSpeechAt: TimeInterval = 0
var speechCandidateStartedAt: TimeInterval = 0
var bargeInEmitted = false
var finishSignalSource: DispatchSourceSignal?

// Diagnostic heartbeat: proves the process is alive and shows whether audio
// buffers reach the tap and whether the recognizer ever calls back.
func heartbeat() {
    let engineRunning = audioEngine?.isRunning ?? false
    emit("HB cycle=\(cycle) taps=\(tapCount) results=\(resultCount) engine=\(engineRunning) speech=\(speechDetected) peak=\(String(format: "%.4f", peakLevel)) rms=\(String(format: "%.4f", rmsLevel))")
    peakLevel = 0
    rmsLevel = 0
    if audioEngine != nil, !engineRunning {
        emit("ERROR engine-stopped")
        restart(after: 1)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { heartbeat() }
}

func teardown() {
    if let engine = audioEngine {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
    audioEngine = nil
    recordingFile = nil
    task?.cancel()
    task = nil
    if let url = recordingURL {
        try? FileManager.default.removeItem(at: url)
    }
    recordingURL = nil
}

func restart(after delay: Double) {
    cycle += 1
    teardown()
    DispatchQueue.global().asyncAfter(deadline: .now() + delay) { startCycle() }
}

func preferredText(from result: SFSpeechRecognitionResult) -> String {
    let candidates = result.transcriptions.map {
        $0.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if recognitionMode == "dictation" || recognitionMode == "barge-in" {
        return candidates.first ?? ""
    }
    return candidates.first(where: { text in
        wakeBias.contains(where: { text.contains($0) })
    }) ?? candidates.first ?? ""
}

func recognizeRecording(_ url: URL, cycle expectedCycle: Int) {
    guard expectedCycle == cycle, let recognizer = recognizer else { return }
    let req = SFSpeechURLRecognitionRequest(url: url)
    req.taskHint = recognitionMode == "wake" ? .search : .dictation
    if recognitionMode == "wake" { req.contextualStrings = wakeBias }

    task = recognizer.recognitionTask(with: req) { result, error in
        guard expectedCycle == cycle else { return }
        resultCount += 1
        if let result = result {
            let text = preferredText(from: result)
            if !text.isEmpty { emit((result.isFinal ? "FINAL " : "TEXT ") + text) }
            if result.isFinal {
                restart(after: 0.1)
                return
            }
        }
        if let error = error {
            let ns = error as NSError
            emit("ERROR \(ns.domain) \(ns.code)")
            restart(after: 0.2)
        }
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
        if expectedCycle == cycle {
            emit("ERROR recognition-timeout")
            restart(after: 0)
        }
    }
}

func finishRecording(_ expectedCycle: Int) {
    guard expectedCycle == cycle, let engine = audioEngine, let url = recordingURL else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    audioEngine = nil
    recordingFile = nil
    recognizeRecording(url, cycle: expectedCycle)
}

func monitorRecording(_ expectedCycle: Int) {
    guard expectedCycle == cycle, audioEngine != nil else { return }
    let now = ProcessInfo.processInfo.systemUptime
    let shouldFinish = speechDetected
        ? now - lastSpeechAt >= silenceAfterSpeech || now - speechStartedAt >= maximumSpeechSegmentDuration
        : now - segmentStartedAt >= silentSegmentDuration
    if shouldFinish {
        finishRecording(expectedCycle)
        return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
        monitorRecording(expectedCycle)
    }
}

func startCycle() {
    if !externalAsr {
        guard let recognizer = recognizer, recognizer.isAvailable else {
            emit("ERROR recognizer-unavailable")
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { startCycle() }
            return
        }
    }
    let my = cycle

    let engine = AVAudioEngine()
    audioEngine = engine
    segmentStartedAt = ProcessInfo.processInfo.systemUptime
    speechDetected = false
    speechStartedAt = 0
    lastSpeechAt = 0
    speechCandidateStartedAt = 0
    bargeInEmitted = false
    let input = engine.inputNode
    if recognitionMode == "barge-in" {
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            emit("ERROR voice-processing \(error)")
        }
    }
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
        emit("ERROR bad-format")
        restart(after: 2)
        return
    }

    var pcmConverter: AVAudioConverter?
    var pcmFormat: AVAudioFormat?
    if externalAsr {
        pcmFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        )
        if let target = pcmFormat {
            pcmConverter = AVAudioConverter(from: format, to: target)
        }
        guard pcmFormat != nil, pcmConverter != nil else {
            emit("ERROR pcm-converter")
            restart(after: 2)
            return
        }
    } else {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("customer-agent-wake-\(ProcessInfo.processInfo.processIdentifier)-\(my).caf")
        do {
            recordingFile = try AVAudioFile(forWriting: url, settings: format.settings)
            recordingURL = url
        } catch {
            emit("ERROR recording-file \(error)")
            restart(after: 2)
            return
        }
    }

    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        tapCount += 1
        var bufferPeak: Float = 0
        var sumOfSquares: Float = 0
        var sampledFrames = 0
        if let ch = buffer.floatChannelData?[0] {
            let n = Int(buffer.frameLength)
            var i = 0
            while i < n {
                let v = abs(ch[i])
                if v > peakLevel { peakLevel = v }
                if v > bufferPeak { bufferPeak = v }
                sumOfSquares += v * v
                sampledFrames += 1
                i += 8
            }
        }
        let bufferRms = sampledFrames > 0
            ? sqrt(sumOfSquares / Float(sampledFrames))
            : 0
        if bufferRms > rmsLevel { rmsLevel = bufferRms }
        let now = ProcessInfo.processInfo.systemUptime
        let requiresBargeInOnset = recognitionMode == "barge-in" && !bargeInEmitted
        let threshold = requiresBargeInOnset ? bargeInSpeechPeakThreshold : speechPeakThreshold
        let isSpeechLevel = bufferPeak >= threshold
            && (!requiresBargeInOnset || bufferRms >= bargeInSpeechRmsThreshold)
        if isSpeechLevel {
            if recognitionMode == "barge-in" && !speechDetected {
                if speechCandidateStartedAt == 0 { speechCandidateStartedAt = now }
                if now - speechCandidateStartedAt >= bargeInSustainDuration {
                    speechDetected = true
                    speechStartedAt = speechCandidateStartedAt
                    lastSpeechAt = now
                    if !bargeInEmitted {
                        bargeInEmitted = true
                        emit("BARGE_IN")
                    }
                }
            } else {
                if !speechDetected { speechStartedAt = now }
                speechDetected = true
                lastSpeechAt = now
            }
        } else if recognitionMode == "barge-in" && !speechDetected {
            speechCandidateStartedAt = 0
        }
        if externalAsr, let converter = pcmConverter, let target = pcmFormat,
           let data = convertTo16kMono(buffer, converter: converter, outputFormat: target) {
            pcmOutputQueue.async { writePcm(data) }
        } else {
            try? recordingFile?.write(from: buffer)
        }
    }

    engine.prepare()
    do {
        try engine.start()
    } catch {
        emit("ERROR engine \(error)")
        restart(after: 2.0)
        return
    }

    if !externalAsr {
        // Native live-buffer recognition is unreliable on the target macOS build.
        monitorRecording(my)
    }
}

func begin() {
    if !externalAsr {
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeArg))
        signal(SIGUSR1, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        source.setEventHandler { finishRecording(cycle) }
        source.resume()
        finishSignalSource = source
    }
    emit("READY")
    heartbeat()
    startCycle()
}

if pcmSelfTest {
    runPcmSelfTest()
    exit(0)
} else if externalAsr {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        begin()
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                guard granted else {
                    emit("ERROR mic-auth-denied")
                    exit(3)
                }
                begin()
            }
        }
    default:
        emit("ERROR mic-auth-denied")
        exit(3)
    }
} else {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized:
        begin()
    case .notDetermined:
        // Triggers the system prompt (attributed to the host Electron app).
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    emit("ERROR speech-auth \(status.rawValue)")
                    exit(2)
                }
                begin()
            }
        }
    default:
        emit("ERROR speech-auth-denied")
        exit(2)
    }
}

dispatchMain()
