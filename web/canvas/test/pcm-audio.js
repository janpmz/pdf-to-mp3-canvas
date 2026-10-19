import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../live-audio-playback-worklet.js', import.meta.url), 'utf8');

export function createProcessor(options) {
  let Processor;
  class TestAudioWorkletProcessor {
    constructor() {
      this.sent = [];
      this.port = { onmessage: null, postMessage: (message) => this.sent.push(structuredClone(message)) };
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor: TestAudioWorkletProcessor, Float32Array, Math, Number,
    sampleRate: 24000,
    registerProcessor(name, constructor) {
      assert.equal(name, 'pcm-playback-processor');
      Processor = constructor;
    },
  });
  return new Processor(options);
}

export class FakeAudioWorkletNode {
  constructor(context, name, options) {
    assert.equal(name, 'pcm-playback-processor');
    this.context = context;
    this.processor = createProcessor(options);
    this.sent = [];
    this.incoming = [];
    this.rendered = [];
    this.connected = false;
    this.disconnected = false;
    this.holdMessages = false;
    this.port = {
      onmessage: null,
      postMessage: (message, transfer = []) => {
        const copied = structuredClone(message, { transfer });
        this.sent.push(copied);
        this.processor.port.onmessage({ data: copied });
      },
      close: () => { this.portClosed = true; },
    };
    this.processor.port.postMessage = (message) => {
      this.processor.sent.push(structuredClone(message));
      this.incoming.push(structuredClone(message));
      if (!this.holdMessages) this.flushMessages();
    };
    context.worklets.push(this);
  }
  connect() { this.connected = true; this.disconnected = false; }
  disconnect() { this.connected = false; this.disconnected = true; }
  flushMessages() {
    while (this.incoming.length) {
      const data = this.incoming.shift();
      this.port.onmessage?.({ data });
    }
  }
  render(frames) {
    const output = new Float32Array(frames);
    if (this.connected && this.context.state === 'running') this.processor.process([], [[output]]);
    this.rendered.push(output);
    return output;
  }
}

export class FakeAudioContext {
  static latest;
  constructor({ sampleRate = 24000 } = {}) {
    FakeAudioContext.latest = this;
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.frames = 0;
    this.state = 'suspended';
    this.destination = {};
    this.worklets = [];
    this.loadedModules = [];
    this.audioWorklet = { addModule: async (url) => { this.loadedModules.push(url); } };
  }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; this.worklets.forEach((node) => node.disconnect()); }
  advance(seconds) { this.advanceFrames(Math.round(seconds * this.sampleRate)); }
  advanceFrames(frames) {
    if (this.state !== 'running') return;
    while (frames > 0 && this.state === 'running') {
      const count = Math.min(128, frames);
      this.frames += count;
      this.currentTime = this.frames / this.sampleRate;
      for (const node of this.worklets) node.render(count);
      frames -= count;
    }
  }
}
