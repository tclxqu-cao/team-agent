const SAMPLE_RATE = 16_000;
const TAIL_PADDING_SAMPLES = SAMPLE_RATE * 0.4;
function cleanText(text) {
    return text.replaceAll("\uFFFD", "").trim();
}
export class AsrEngine {
    constructor(recognizer) {
        this.recognizer = recognizer;
    }
    createSession(sessionId, generation, emit) {
        const recognizer = this.recognizer;
        const stream = recognizer.createStream();
        let latestText = "";
        let utteranceId = 0;
        let closed = false;
        const ensureOpen = () => {
            if (closed)
                throw new Error("ASR session is closed");
        };
        const decodeReady = () => {
            while (recognizer.isReady(stream))
                recognizer.decode(stream);
        };
        const currentText = () => cleanText(recognizer.getResult(stream).text);
        const emitPartial = () => {
            const text = currentText();
            if (text && text !== latestText) {
                latestText = text;
                emit({ type: "partial", sessionId, generation, text });
            }
        };
        const reset = () => {
            ensureOpen();
            recognizer.reset(stream);
            latestText = "";
        };
        const emitFinalAndReset = () => {
            const text = currentText();
            if (text) {
                utteranceId += 1;
                emit({ type: "final", sessionId, generation, utteranceId, text });
            }
            reset();
        };
        return {
            acceptPcm(samples) {
                ensureOpen();
                if (samples.length === 0)
                    return;
                stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
                decodeReady();
                emitPartial();
                if (recognizer.isEndpoint(stream))
                    emitFinalAndReset();
            },
            finish() {
                ensureOpen();
                stream.acceptWaveform({
                    samples: new Float32Array(TAIL_PADDING_SAMPLES),
                    sampleRate: SAMPLE_RATE,
                });
                decodeReady();
                emitFinalAndReset();
            },
            reset,
            close() {
                if (closed)
                    return;
                stream.inputFinished();
                closed = true;
            },
        };
    }
}
//# sourceMappingURL=asr-engine.js.map