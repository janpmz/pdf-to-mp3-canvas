const SAMPLE_RATE = 24000;

// The worklet keeps the audio clock; waiting for more sound adds no reading time.
export class PcmPlaybackQueue {
  constructor(context, { onEnded = () => {}, AudioWorkletNodeClass = globalThis.AudioWorkletNode } = {}) {
    if (context.sampleRate !== SAMPLE_RATE) throw new Error('Speech playback needs a 24 kHz audio context.');
    if (!AudioWorkletNodeClass) throw new Error('This browser cannot play streamed speech.');
    this.context = context;
    this.onEnded = onEnded;
    this.generation = 0;
    this.playedSamples = 0;
    this.totalSamples = 0;
    this.complete = false;
    this.ended = false;
    this.disposed = false;
    this.node = new AudioWorkletNodeClass(context, 'pcm-playback-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { reportProgress: true },
    });
    this.node.port.onmessage = ({ data }) => {
      if (this.disposed || data?.generation !== this.generation || !['progress', 'drained'].includes(data.type)) return;
      if (!Number.isSafeInteger(data.playedSamples) || data.playedSamples < this.playedSamples || data.playedSamples > this.totalSamples) return;
      this.playedSamples = data.playedSamples;
      if (data.type === 'drained' && this.complete && !this.ended) {
        this.ended = true;
        this.onEnded();
      }
    };
    this.node.connect(context.destination);
    this.clear();
  }
  append(samples, sampleRate) {
    if (this.disposed) return;
    if (sampleRate !== SAMPLE_RATE || sampleRate !== this.context.sampleRate) throw new Error('The speech sample rate does not match playback.');
    if (!(samples instanceof Float32Array)) throw new Error('The speech audio could not be read.');
    if (!samples.length) return;
    if (this.complete) throw new Error('Start a new sentence before adding more speech.');
    // Cached samples must stay intact for replay.
    const copy = samples.slice();
    this.totalSamples += copy.length;
    this.node.port.postMessage({ type: 'chunk', generation: this.generation, samples: copy }, [copy.buffer]);
  }
  finish() {
    if (this.disposed || this.complete) return;
    this.complete = true;
    this.node.port.postMessage({ type: 'finish', generation: this.generation });
    if (this.totalSamples === 0 && !this.ended) {
      this.ended = true;
      this.onEnded();
    }
  }
  clear() {
    if (this.disposed) return;
    this.generation += 1;
    this.playedSamples = 0;
    this.totalSamples = 0;
    this.complete = false;
    this.ended = false;
    this.node.port.postMessage({ type: 'interrupt', generation: this.generation });
  }
  position() { return this.playedSamples / SAMPLE_RATE; }
  hasStarted() { return this.playedSamples > 0; }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.node.port.onmessage = null;
    this.node.port.close?.();
    this.node.disconnect();
  }
}
