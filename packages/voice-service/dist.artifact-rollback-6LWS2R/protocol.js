function record(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("message must be a JSON object");
    }
    return value;
}
function sessionId(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("sessionId must be a non-empty string");
    }
    return value;
}
function generation(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("generation must be a non-negative integer");
    }
    return value;
}
export function parseAsrControl(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error("message must be valid JSON");
    }
    const input = record(value);
    const type = input.type;
    const id = sessionId(input.sessionId);
    const gen = generation(input.generation);
    if (type === "reset" || type === "finish" || type === "stop") {
        return { type, sessionId: id, generation: gen };
    }
    if (type !== "start")
        throw new Error("type is not supported");
    if (input.sampleRate !== 16_000)
        throw new Error("sampleRate must be 16000");
    if (input.mode !== "wake" && input.mode !== "dictation" && input.mode !== "barge-in") {
        throw new Error("mode is not supported");
    }
    if (input.wakeWord !== undefined && (typeof input.wakeWord !== "string" || !input.wakeWord.trim())) {
        throw new Error("wakeWord must be a non-empty string");
    }
    return {
        type,
        sessionId: id,
        generation: gen,
        sampleRate: 16_000,
        mode: input.mode,
        ...(typeof input.wakeWord === "string" ? { wakeWord: input.wakeWord.trim() } : {}),
    };
}
//# sourceMappingURL=protocol.js.map