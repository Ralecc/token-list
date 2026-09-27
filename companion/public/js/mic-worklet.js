// Runs on the audio thread: hands microphone samples to the page in ~43 ms blocks.
class MicCapture extends AudioWorkletProcessor {
  buffer = new Float32Array(2048);
  length = 0;

  process(inputs) {
    const input = inputs[0]?.[0];
    for (let offset = 0; input && offset < input.length; ) {
      const n = Math.min(input.length - offset, this.buffer.length - this.length);
      this.buffer.set(input.subarray(offset, offset + n), this.length);
      this.length += n;
      offset += n;
      if (this.length === this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic-capture', MicCapture);
