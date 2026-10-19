const START_BUFFER_MS = 100;
const FADE_MS = 4;
const PROGRESS_MS = 25;

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunks = [];
    this.chunkOffset = 0;
    this.queuedSamples = 0;
    this.started = false;
    this.finishing = false;
    this.drainedSent = true;
    this.gain = 0;
    this.tracking = options?.processorOptions?.reportProgress === true;
    this.generation = 0;
    this.playedSamples = 0;
    this.lastReportedSamples = 0;
    this.progressSamples = Math.max(1, Math.round(sampleRate * PROGRESS_MS / 1000));
    this.startSamples = Math.max(1, Math.round(sampleRate * START_BUFFER_MS / 1000));
    this.fadeSamples = Math.max(1, Math.round(sampleRate * FADE_MS / 1000));

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (message?.type === "interrupt") {
      this.reset(Number.isSafeInteger(message.generation) ? message.generation : 0);
      return;
    }
    if (this.tracking && message?.generation !== this.generation) return;
    if (message?.type === "chunk" && message.samples instanceof Float32Array) {
      if (!message.samples.length) return;
      this.chunks.push(message.samples);
      this.queuedSamples += message.samples.length;
      this.drainedSent = false;
      return;
    }
    if (message?.type === "finish") {
      this.finishing = true;
      this.sendDrainedIfReady();
      return;
    }
  }

  reset(generation = 0) {
    this.chunks = [];
    this.chunkOffset = 0;
    this.queuedSamples = 0;
    this.started = false;
    this.finishing = false;
    this.drainedSent = true;
    this.gain = 0;
    this.generation = generation;
    this.playedSamples = 0;
    this.lastReportedSamples = 0;
  }

  reportPosition(force = false) {
    if (!this.tracking || (!force && this.playedSamples - this.lastReportedSamples < this.progressSamples)) return;
    this.lastReportedSamples = this.playedSamples;
    this.port.postMessage({ type: "progress", generation: this.generation, playedSamples: this.playedSamples });
  }

  sendDrainedIfReady() {
    if (!this.finishing || this.queuedSamples > 0 || this.drainedSent) return;
    this.finishing = false;
    this.drainedSent = true;
    this.port.postMessage(this.tracking
      ? { type: "drained", generation: this.generation, playedSamples: this.playedSamples }
      : { type: "drained" });
  }

  nextSample() {
    while (this.chunks.length) {
      const chunk = this.chunks[0];
      if (this.chunkOffset < chunk.length) {
        const value = chunk[this.chunkOffset];
        this.chunkOffset += 1;
        this.queuedSamples -= 1;
        return value;
      }
      this.chunks.shift();
      this.chunkOffset = 0;
    }
    return 0;
  }

  process(_inputs, outputs) {
    const channel = outputs[0]?.[0];
    if (!channel) return true;
    channel.fill(0);

    if (!this.started && (
      this.queuedSamples >= this.startSamples
      || (this.finishing && this.queuedSamples > 0)
    )) {
      this.started = true;
      this.gain = 0;
    }

    let outputIndex = 0;
    while (this.started && outputIndex < channel.length && this.queuedSamples > 0) {
      const targetGain = Math.min(1, this.queuedSamples / this.fadeSamples);
      const gainStep = 1 / this.fadeSamples;
      if (this.gain < targetGain) this.gain = Math.min(targetGain, this.gain + gainStep);
      else if (this.gain > targetGain) this.gain = Math.max(targetGain, this.gain - gainStep);
      channel[outputIndex] = this.nextSample() * this.gain;
      outputIndex += 1;
    }

    const firstOutput = this.playedSamples === 0 && outputIndex > 0;
    this.playedSamples += outputIndex;
    const underflow = this.started && this.queuedSamples === 0;
    if (underflow) {
      this.started = false;
      this.gain = 0;
    }
    if (outputIndex > 0) this.reportPosition(firstOutput || underflow);
    this.sendDrainedIfReady();
    return true;
  }
}

registerProcessor("pcm-playback-processor", PcmPlaybackProcessor);
