// Capture mono audio as 100 ms, 16 kHz Float32 PCM frames, including an ordered tail flush.
class DictationCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.sum = 0;
    this.weight = 0;
    this.frame = new Float32Array(1600);
    this.offset = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data.type !== "flush" || this.stopped) return;
      this.stopped = true;
      this.flush();
      this.port.postMessage({ type: "flushed" });
    };
  }

  flush() {
    if (!this.offset) return;
    const pcm = this.frame.slice(0, this.offset).buffer;
    this.port.postMessage({ type: "pcm", pcm }, [pcm]);
    this.offset = 0;
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      let remaining = 1;
      while (remaining > 1e-9) {
        const weight = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * weight;
        this.weight += weight;
        remaining -= weight;
        if (this.weight >= this.ratio - 1e-9) {
          this.frame[this.offset++] = this.sum / this.ratio;
          this.weight = 0;
          this.sum = 0;
          if (this.offset === this.frame.length) this.flush();
        }
      }
    }
    return true;
  }
}
registerProcessor("dictation-capture", DictationCaptureProcessor);
