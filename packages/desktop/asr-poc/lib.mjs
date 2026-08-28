export function parseArgs(argv) {
  const options = {
    input: null,
    json: false,
    microphone: null,
    modelDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--model-dir" || arg === "--input") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg === "--model-dir" ? "modelDir" : "input"] = value;
      i += 1;
    } else if (arg === "--microphone") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        options.microphone = value;
        i += 1;
      } else {
        options.microphone = "default";
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.modelDir) throw new Error("--model-dir is required");
  if (Number(options.input !== null) + Number(options.microphone !== null) !== 1) {
    throw new Error("exactly one of --input or --microphone is required");
  }
  return options;
}

export function cleanRecognizerText(text) {
  return text.replaceAll("\uFFFD", "").trim();
}

export class Float32LeDecoder {
  #carry = Buffer.alloc(0);

  push(chunk) {
    const bytes = this.#carry.length > 0
      ? Buffer.concat([this.#carry, chunk])
      : chunk;
    const completeBytes = bytes.length - (bytes.length % 4);
    const samples = new Float32Array(completeBytes / 4);
    for (let offset = 0; offset < completeBytes; offset += 4) {
      samples[offset / 4] = bytes.readFloatLE(offset);
    }
    this.#carry = Buffer.from(bytes.subarray(completeBytes));
    return samples;
  }

  flush() {
    if (this.#carry.length > 0) {
      throw new Error(`${this.#carry.length} trailing PCM bytes`);
    }
  }
}

export class MetricTracker {
  constructor(startedAt) {
    this.startedAt = startedAt;
    this.addonLoadedAt = null;
    this.modelLoadedAt = null;
    this.audioStartedAt = null;
    this.firstPartialAt = null;
    this.finalAt = null;
  }

  markAddonLoaded(at) {
    this.addonLoadedAt = at;
  }

  markModelLoaded(at) {
    this.modelLoadedAt = at;
  }

  markAudioStarted(at) {
    this.audioStartedAt = at;
  }

  markPartial(at) {
    if (this.firstPartialAt === null) this.firstPartialAt = at;
  }

  markFinal(at) {
    this.finalAt = at;
  }

  summary() {
    return {
      addonLoadMs: this.addonLoadedAt - this.startedAt,
      firstPartialMs: this.firstPartialAt === null
        ? null
        : this.firstPartialAt - this.audioStartedAt,
      finalMs: this.finalAt === null
        ? null
        : this.finalAt - this.audioStartedAt,
      modelLoadMs: this.modelLoadedAt - this.addonLoadedAt,
    };
  }
}
