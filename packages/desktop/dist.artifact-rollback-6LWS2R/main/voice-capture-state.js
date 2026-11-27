export function getVoiceCaptureAction(capturing, conversation) {
    if (capturing)
        return "append";
    if (conversation)
        return "start";
    return "ignore";
}
export function isWakeMatch(heard, variants, isFinal) {
    if (variants.some((variant) => heard.includes(variant)))
        return true;
    if (!isFinal)
        return false;
    return variants.some((variant) => (heard.length > 0
        && heard.length === variant.length - 1
        && variant.startsWith(heard)));
}
export function getWakeCommandSuffix(heard, variants) {
    const match = variants
        .map((variant) => ({ variant, index: heard.indexOf(variant) }))
        .filter(({ index }) => index >= 0)
        .sort((a, b) => a.index - b.index)[0];
    return match ? heard.slice(match.index + match.variant.length) : null;
}
export function replaceWakeCommandSuffix(_current, suffix) {
    return suffix;
}
export function shouldRestartWakeListener(desired, suspended) {
    return desired && !suspended;
}
export function shouldRearmIgnoredWakeKeyword(windowVisible, wakeDesired) {
    return windowVisible && wakeDesired;
}
export function shouldInvalidateVoiceProvider(active, failed) {
    return active === failed;
}
export function getVoiceCaptureSilenceTimeout(commandText) {
    return commandText.trim().length > 0 ? 3000 : 8000;
}
export function shouldRearmWakeOnlyCapture(capturing, isFinal, commandText) {
    return capturing && isFinal && commandText.trim().length === 0;
}
export function shouldFinalizeVoiceCapture(capturing, isFinal, commandText) {
    return capturing && isFinal && commandText.trim().length > 0;
}
export function parseWakeTranscriptLine(line) {
    if (line.startsWith("TEXT ")) {
        return { heard: line.slice(5), isFinal: false };
    }
    if (line.startsWith("FINAL ")) {
        return { heard: line.slice(6), isFinal: true };
    }
    return null;
}
export function parseWakeControlLine(line) {
    return line === "BARGE_IN" ? "barge-in" : null;
}
export function routeVoiceServiceResult(current, event) {
    if (event.sessionId !== current.sessionId || event.generation !== current.generation) {
        return { action: "ignore", lastFinalUtteranceId: current.lastFinalUtteranceId };
    }
    if (event.type === "partial") {
        return { action: "partial", lastFinalUtteranceId: current.lastFinalUtteranceId };
    }
    if (event.type === "keyword") {
        return { action: "keyword", lastFinalUtteranceId: current.lastFinalUtteranceId };
    }
    if (!Number.isSafeInteger(event.utteranceId)
        || event.utteranceId <= current.lastFinalUtteranceId) {
        return { action: "ignore", lastFinalUtteranceId: current.lastFinalUtteranceId };
    }
    return { action: "final", lastFinalUtteranceId: event.utteranceId };
}
//# sourceMappingURL=voice-capture-state.js.map