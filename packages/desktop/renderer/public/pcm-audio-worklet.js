class PcmStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(1);
    this.capacity = 1;
    this.readIndex = 0;
    this.writeIndex = 0;
    this.size = 0;
    this.phase = 0;
    this.inputSampleRate = 24000;
    this.startThreshold = 2880;
    this.generation = null;
    this.playing = false;
    this.inputEnded = false;
    this.underrunReported = false;
    this.terminalReported = false;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  resetBuffer() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.size = 0;
    this.phase = 0;
    this.playing = false;
    this.inputEnded = false;
    this.underrunReported = false;
    this.terminalReported = false;
  }

  handleMessage(message) {
    if (message.type === "start") {
      this.inputSampleRate = message.sampleRate;
      this.capacity = message.sampleRate;
      this.startThreshold = Math.ceil(message.sampleRate * 0.12);
      this.ring = new Float32Array(this.capacity);
      this.generation = message.generation;
      this.resetBuffer();
      return;
    }
    if (message.generation !== this.generation) return;
    if (message.type === "chunk") {
      const samples = message.samples;
      if (!(samples instanceof Float32Array) || samples.length > this.capacity - this.size) {
        const generation = this.generation;
        this.resetBuffer();
        this.generation = null;
        this.port.postMessage({ type: "overflow", generation });
        return;
      }
      for (let index = 0; index < samples.length; index += 1) {
        this.ring[this.writeIndex] = samples[index];
        this.writeIndex = (this.writeIndex + 1) % this.capacity;
      }
      this.size += samples.length;
      return;
    }
    if (message.type === "finish") {
      this.inputEnded = true;
      return;
    }
    if (message.type === "flush") {
      const generation = this.generation;
      this.resetBuffer();
      this.generation = null;
      this.port.postMessage({ type: "stopped", generation });
    }
  }

  sampleAt(offset) {
    return this.ring[(this.readIndex + offset) % this.capacity];
  }

  reportDrained() {
    if (this.terminalReported || this.generation === null) return;
    this.terminalReported = true;
    const generation = this.generation;
    this.generation = null;
    this.port.postMessage({ type: "drained", generation });
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);
    if (this.generation === null) return true;
    if (!this.playing) {
      if (this.size >= this.startThreshold || (this.inputEnded && this.size > 0)) {
        this.playing = true;
        this.underrunReported = false;
      } else if (this.inputEnded && this.size === 0) {
        this.reportDrained();
        return true;
      } else {
        return true;
      }
    }

    const ratio = this.inputSampleRate / sampleRate;
    for (let index = 0; index < output.length; index += 1) {
      if (this.size === 0) {
        if (this.inputEnded) this.reportDrained();
        else {
          this.playing = false;
          if (!this.underrunReported) {
            this.underrunReported = true;
            this.port.postMessage({ type: "underrun", generation: this.generation });
          }
        }
        break;
      }
      const first = this.sampleAt(0);
      const second = this.size > 1 ? this.sampleAt(1) : first;
      output[index] = first + (second - first) * this.phase;
      this.phase += ratio;
      const consumed = Math.min(Math.floor(this.phase), this.size);
      if (consumed > 0) {
        this.readIndex = (this.readIndex + consumed) % this.capacity;
        this.size -= consumed;
        this.phase -= consumed;
      }
    }
    return true;
  }
}

registerProcessor("pcm-stream-player", PcmStreamProcessor);
