/** Stateful mono resampling, preserving fractional samples between capture callbacks. */
export class PcmResampler {
  private readonly ratio: number;
  private sum = 0;
  private weight = 0;
  private frame = new Float32Array(1600);
  private offset = 0;

  constructor(sampleRate: number, private readonly emit: (pcm: ArrayBuffer) => void) {
    this.ratio = sampleRate / 16_000;
  }

  push(channels: Float32Array[]): void {
    if (!channels.length) return;
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
  }

  flush(): void {
    if (!this.offset) return;
    this.emit(this.frame.slice(0, this.offset).buffer);
    this.offset = 0;
  }
}
