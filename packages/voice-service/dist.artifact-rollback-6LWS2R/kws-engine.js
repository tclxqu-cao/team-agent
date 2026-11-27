const SAMPLE_RATE = 16_000;
export class KwsEngine {
    constructor(spotter) {
        this.spotter = spotter;
    }
    createSession(sessionId, generation, emit) {
        const spotter = this.spotter;
        const stream = spotter.createStream();
        let detected = false;
        let closed = false;
        const ensureOpen = () => {
            if (closed)
                throw new Error("KWS session is closed");
        };
        const reset = () => {
            ensureOpen();
            spotter.reset(stream);
            detected = false;
        };
        return {
            acceptPcm(samples) {
                ensureOpen();
                if (samples.length === 0 || detected)
                    return;
                stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
                while (spotter.isReady(stream))
                    spotter.decode(stream);
                const keyword = spotter.getResult(stream).keyword.trim();
                if (!keyword)
                    return;
                detected = true;
                spotter.reset(stream);
                emit({ type: "keyword", sessionId, generation, keyword });
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
//# sourceMappingURL=kws-engine.js.map