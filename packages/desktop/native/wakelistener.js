// Native wake-word listener via osascript (JXA + Speech framework).
// Runs under Script Editor's TCC identity (already speech-authorized),
// avoiding the Info.plist requirement that kills standalone binaries.
// Protocol (stdout lines): READY | TEXT <transcript> | ERROR <desc>
var localeId = 'zh-CN';
// Bias the recognizer toward the wake word so it doesn't get heard as
// homophones like "小心微信" / "嘿Siri".
var WAKE_WORDS = ['小智', '小志', '小知', '小芝', '小之', '小值', '小纸'];

ObjC.import('Speech');
ObjC.import('AVFoundation');
ObjC.import('Foundation');

function emit(s) { console.log(s); }

var recognizer = $.SFSpeechRecognizer.alloc.initWithLocale($.NSLocale.alloc.initWithLocaleIdentifier(localeId));
var audioEngine = null;
var request = null;
var task = null;
var cycle = 0;
var restartAt = 0; // ms timestamp; checked by the run-loop pump below

function teardown() {
  if (audioEngine) {
    try { audioEngine.inputNode.removeTapOnBus(0); } catch (e) {}
    try { audioEngine.stop(); } catch (e) {}
    audioEngine = null;
  }
  if (task) { try { task.cancel(); } catch (e) {} task = null; }
  if (request) { try { request.endAudio(); } catch (e) {} request = null; }
}

function scheduleRestart(delaySec) {
  cycle += 1;
  teardown();
  restartAt = Date.now() + delaySec * 1000;
}

function startCycle() {
  if (!recognizer || !recognizer.available) {
    emit('ERROR recognizer-unavailable');
    scheduleRestart(2);
    return;
  }
  var my = cycle;
  var req = $.SFSpeechAudioBufferRecognitionRequest.alloc.init;
  req.shouldReportPartialResults = true;
  req.taskHint = 1; // SFSpeechRecognitionTaskHint.search
  req.contextualStrings = WAKE_WORDS;
  request = req;

  var engine = $.AVAudioEngine.alloc.init;
  audioEngine = engine;
  var input = engine.inputNode;
  var format = input.outputFormatForBus(0);
  input.installTapOnBusBufferSizeFormatBlock(0, 1024, format, function (buffer) {
    req.appendAudioPCMBuffer(buffer);
  });

  task = recognizer.recognitionTaskWithRequestResultHandler(req, function (result, error) {
    if (my !== cycle) return;
    if (result && !result.isNil()) {
      var text = ObjC.unwrap(result.bestTranscription.formattedString).trim();
      if (text.length > 0) emit('TEXT ' + text);
      if (result.isFinal) scheduleRestart(0.3);
    } else if (!error || error.isNil()) {
      return;
    }
    if (error && !error.isNil()) {
      emit('ERROR ' + ObjC.unwrap(error.domain) + ' ' + error.code);
      scheduleRestart(1);
    }
  });

  engine.prepare;
  var ok = true;
  try { engine.startAndReturnError(null); } catch (e) { ok = false; }
  if (!ok) { emit('ERROR engine-start'); scheduleRestart(2); return; }

  // Recycle the session periodically: long-lived recognition tasks accumulate
  // context and eventually stop reporting, which silently kills wake-wait.
  restartAt = Date.now() + 15000;
}

// JXA may hand back the enum as a string — coerce before comparing
var status = Number($.SFSpeechRecognizer.authorizationStatus);
if (status === 3 || status === 4) {
  // 3 = authorized; 4 = provisional (also usable)
  emit('READY');
  startCycle();
} else {
  emit('ERROR speech-auth ' + status);
  emit('EXIT');
}

// pump the main run loop forever (drives GCD main-queue callbacks) and
// service the restart timer, which JXA cannot express with GCD APIs
while (true) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
  if (restartAt > 0 && Date.now() >= restartAt) {
    restartAt = 0;
    startCycle();
  }
}
