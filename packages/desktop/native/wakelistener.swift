// Native wake-word listener for macOS (Swift, Speech framework).
// Spawned by the Electron main process so TCC attribution belongs to the
// app (Info.plist carries NSMicrophoneUsageDescription and
// NSSpeechRecognitionUsageDescription).
//
// Protocol (stdout lines):
//   READY           listener up and authorized
//   TEXT <t>        partial transcript (main matches the full wake word)
//   FINAL <t>       final transcript (also allows safe truncated matching)
//   ERROR <desc>    non-fatal issue; the loop keeps retrying
// Exit codes: 2 speech-auth denied, 3 mic denied

import Foundation
import Speech
import AVFoundation

let localeArg = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "zh-CN"

func emit(_ s: String) {
    print(s)
    fflush(stdout)
}

let wakeBias = [
    "小智", "小志", "小知", "小芝", "小之", "小值", "小纸", "小镇",
    "你好小智", "小智你好", "小智在吗", "小智请回答"
]
let speechPeakThreshold: Float = 0.009
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
var segmentStartedAt: TimeInterval = 0
var speechDetected = false
var lastSpeechAt: TimeInterval = 0

// Diagnostic heartbeat: proves the process is alive and shows whether audio
// buffers reach the tap and whether the recognizer ever calls back.
func heartbeat() {
    let engineRunning = audioEngine?.isRunning ?? false
    emit("HB cycle=\(cycle) taps=\(tapCount) results=\(resultCount) engine=\(engineRunning) speech=\(speechDetected) peak=\(String(format: "%.4f", peakLevel))")
    peakLevel = 0
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
    return candidates.first(where: { text in
        wakeBias.contains(where: { text.contains($0) })
    }) ?? candidates.first ?? ""
}

func recognizeRecording(_ url: URL, cycle expectedCycle: Int) {
    guard expectedCycle == cycle, let recognizer = recognizer else { return }
    let req = SFSpeechURLRecognitionRequest(url: url)
    req.taskHint = .search
    req.contextualStrings = wakeBias

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
        ? now - lastSpeechAt >= silenceAfterSpeech || now - segmentStartedAt >= maximumSpeechSegmentDuration
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
    guard let recognizer = recognizer, recognizer.isAvailable else {
        emit("ERROR recognizer-unavailable")
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { startCycle() }
        return
    }
    let my = cycle

    let engine = AVAudioEngine()
    audioEngine = engine
    segmentStartedAt = ProcessInfo.processInfo.systemUptime
    speechDetected = false
    lastSpeechAt = 0
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
        emit("ERROR bad-format")
        restart(after: 2)
        return
    }

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

    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        tapCount += 1
        var bufferPeak: Float = 0
        if let ch = buffer.floatChannelData?[0] {
            let n = Int(buffer.frameLength)
            var i = 0
            while i < n {
                let v = abs(ch[i])
                if v > peakLevel { peakLevel = v }
                if v > bufferPeak { bufferPeak = v }
                i += 8
            }
        }
        if bufferPeak >= speechPeakThreshold {
            speechDetected = true
            lastSpeechAt = ProcessInfo.processInfo.systemUptime
        }
        try? recordingFile?.write(from: buffer)
    }

    engine.prepare()
    do {
        try engine.start()
    } catch {
        emit("ERROR engine \(error)")
        restart(after: 2.0)
        return
    }

    // Live buffer recognition is unreliable on the target macOS build. Record
    // until post-speech silence so an utterance is not cut at a fixed boundary.
    monitorRecording(my)
}

func begin() {
    recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeArg))
    emit("READY")
    heartbeat()
    startCycle()
}

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

dispatchMain()
