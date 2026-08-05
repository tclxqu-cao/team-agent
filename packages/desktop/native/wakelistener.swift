// Native wake-word listener for macOS (Swift, Speech framework).
// Spawned by the Electron main process so TCC attribution belongs to the
// app (Info.plist carries NSMicrophoneUsageDescription and
// NSSpeechRecognitionUsageDescription).
//
// Protocol (stdout lines):
//   READY           listener up and authorized
//   TEXT <t>        partial/final transcript (main matches the wake word)
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

let wakeBias = ["小智", "小志", "小知", "小芝", "小之", "小值", "小纸", "小镇"]

var recognizer: SFSpeechRecognizer?
var audioEngine: AVAudioEngine?
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var cycle = 0
var tapCount = 0
var resultCount = 0
var peakLevel: Float = 0

// Diagnostic heartbeat: proves the process is alive and shows whether audio
// buffers reach the tap and whether the recognizer ever calls back.
func heartbeat() {
    emit("HB cycle=\(cycle) taps=\(tapCount) results=\(resultCount) engine=\(audioEngine?.isRunning ?? false) peak=\(String(format: "%.4f", peakLevel))")
    peakLevel = 0
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { heartbeat() }
}

func teardown() {
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()
    audioEngine = nil
    task?.cancel()
    task = nil
    request?.endAudio()
    request = nil
}

func restart(after delay: Double) {
    cycle += 1
    teardown()
    DispatchQueue.global().asyncAfter(deadline: .now() + delay) { startCycle() }
}

func startCycle() {
    guard let recognizer = recognizer, recognizer.isAvailable else {
        emit("ERROR recognizer-unavailable")
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { startCycle() }
        return
    }
    let my = cycle

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.taskHint = .search
    req.contextualStrings = wakeBias
    request = req

    let engine = AVAudioEngine()
    audioEngine = engine
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
        emit("ERROR bad-format")
        restart(after: 2)
        return
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        tapCount += 1
        if let ch = buffer.floatChannelData?[0] {
            let n = Int(buffer.frameLength)
            var i = 0
            while i < n {
                let v = abs(ch[i])
                if v > peakLevel { peakLevel = v }
                i += 8
            }
        }
        req.append(buffer)
    }

    task = recognizer.recognitionTask(with: req) { result, error in
        guard my == cycle else { return }
        resultCount += 1
        if let result = result {
            let text = result.bestTranscription.formattedString
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { emit("TEXT " + text) }
            if result.isFinal { restart(after: 0.3) }
        }
        if let error = error {
            let ns = error as NSError
            emit("ERROR \(ns.domain) \(ns.code)")
            restart(after: 1.0)
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

    // Recycle the session periodically: long-lived recognition tasks
    // accumulate context and eventually stop reporting.
    DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
        if my == cycle { restart(after: 0) }
    }
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
