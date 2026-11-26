// Native wake-word listener via osascript (JXA + Speech framework).
// Runs under Script Editor's TCC identity (already speech-authorized),
// avoiding the Info.plist requirement that kills standalone binaries.
// Protocol (stdout lines): READY | TEXT <transcript> | ERROR <desc> | EXIT
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
// Long-lived JXA scripts never fully release the ObjC objects each cycle
// builds (engine/tap/request/task), so the process carries an age cap and
// hands itself back before the leak compounds; the parent's exit handler
// respawns a fresh one while wake listening is on.
var bootedAt = Date.now();
var MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
var errorTimes = []; // timestamps of recent error-driven restarts
var cycleStartedAt = 0;
var shouldExit = false;
var lastText = '';
var lastTextAt = 0;

function teardown() {
  if (audioEngine) {
    try { audioEngine.inputNode.removeTapOnBus(0); } catch (e) {}
    try { audioEngine.stop(); } catch (e) {}
    // The engine object is kept and reused across cycles; only a failed
    // start discards it (see startCycle). Rebuilding the whole engine
    // every 15s cycle is what piled up leaked ObjC objects before.
  }
  if (task) { try { task.cancel(); } catch (e) {} task = null; }
  if (request) { try { request.endAudio(); } catch (e) {} request = null; }
}

function scheduleRestart(delaySec) {
  cycle += 1;
  teardown();
  restartAt = Date.now() + delaySec * 1000;
}

// Error-driven restarts back off progressively; six inside two minutes
// means the speech pipeline is wedged — exit so the parent respawns a
// fresh process instead of spinning on a rebuild loop.
function noteRestartError() {
  var now = Date.now();
  errorTimes.push(now);
  while (errorTimes.length > 0 && now - errorTimes[0] > 120000) errorTimes.shift();
  return errorTimes.length;
}

function backoffSec(errorCount) {
  if (errorCount <= 2) return 1;
  if (errorCount === 3) return 5;
  if (errorCount === 4) return 15;
  if (errorCount === 5) return 30;
  return 60;
}

function exitFresh() {
  cycle += 1;
  teardown();
  audioEngine = null;
  emit('EXIT');
  shouldExit = true;
  restartAt = 0;
}

function startCycle() {
  if (shouldExit) return;
  if (!recognizer || !recognizer.available) {
    emit('ERROR recognizer-unavailable');
    var misses = noteRestartError();
    if (misses >= 6) { exitFresh(); return; }
    scheduleRestart(backoffSec(misses));
    return;
  }
  var my = cycle;
  var req = $.SFSpeechAudioBufferRecognitionRequest.alloc.init;
  req.shouldReportPartialResults = true;
  req.taskHint = 1; // SFSpeechRecognitionTaskHint.search
  req.contextualStrings = WAKE_WORDS;
  request = req;

  // One engine is reused across cycles; only request + task + tap rotate.
  var engine = audioEngine;
  if (!engine) {
    engine = $.AVAudioEngine.alloc.init;
    audioEngine = engine;
  }
  var input = engine.inputNode;
  var format = input.outputFormatForBus(0);
  input.installTapOnBusBufferSizeFormatBlock(0, 1024, format, function (buffer) {
    req.appendAudioPCMBuffer(buffer);
  });

  task = recognizer.recognitionTaskWithRequestResultHandler(req, function (result, error) {
    if (my !== cycle) return;
    if (result && !result.isNil()) {
      var text = ObjC.unwrap(result.bestTranscription.formattedString).trim();
      // Identical repeated partials are throttled to one per second;
      // ambient noise can otherwise stream lines nonstop.
      var now = Date.now();
      if (text.length > 0 && (text !== lastText || now - lastTextAt > 1000)) {
        lastText = text;
        lastTextAt = now;
        emit('TEXT ' + text);
      }
      if (result.isFinal) scheduleRestart(0.3);
    } else if (!error || error.isNil()) {
      return;
    }
    if (error && !error.isNil()) {
      emit('ERROR ' + ObjC.unwrap(error.domain) + ' ' + error.code);
      var errors = noteRestartError();
      if (errors >= 6) { exitFresh(); return; }
      scheduleRestart(backoffSec(errors));
    }
  });

  engine.prepare;
  var ok = true;
  try { engine.startAndReturnError(null); } catch (e) { ok = false; }
  if (!ok) {
    emit('ERROR engine-start');
    // Discard the wedged engine so the next cycle builds a new one.
    try { engine.stop(); } catch (e) {}
    try { engine.inputNode.removeTapOnBus(0); } catch (e) {}
    audioEngine = null;
    var failures = noteRestartError();
    if (failures >= 6) { exitFresh(); return; }
    scheduleRestart(backoffSec(failures));
    return;
  }

  cycleStartedAt = Date.now();
  // Recycle the session periodically: long-lived recognition tasks accumulate
  // context and eventually stop reporting, which silently kills wake-wait.
  restartAt = Date.now() + 15000;
}

// JXA may hand back the enum as a string — coerce before comparing
var status = Number($.SFSpeechRecognizer.authorizationStatus);
if (status === 0) {
  // notDetermined → trigger the system prompt, then wait for the user's decision
  $.SFSpeechRecognizer.requestAuthorization(function () {});
  var authDeadline = Date.now() + 120000;
  while (Number($.SFSpeechRecognizer.authorizationStatus) === 0 && Date.now() < authDeadline) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
  }
  status = Number($.SFSpeechRecognizer.authorizationStatus);
}
if (status === 3 || status === 4) {
  // 3 = authorized; 4 = provisional (also usable)
  emit('READY');
  startCycle();
} else {
  emit('ERROR speech-auth ' + status);
  emit('EXIT');
  shouldExit = true;
}

// pump the main run loop forever (drives GCD main-queue callbacks) and
// service the restart timer, which JXA cannot express with GCD APIs
while (true) {
  if (shouldExit) break;
  if (Date.now() - bootedAt > MAX_LIFETIME_MS) {
    teardown();
    emit('EXIT');
    break;
  }
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
  if (restartAt > 0 && Date.now() >= restartAt) {
    restartAt = 0;
    // A cycle that ran its full 15s slot without errors is healthy; reset
    // the error window so the backoff ladder starts from scratch.
    if (Date.now() - cycleStartedAt >= 14000) errorTimes = [];
    startCycle();
  }
}
