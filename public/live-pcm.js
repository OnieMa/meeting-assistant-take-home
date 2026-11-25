class MeetingPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.packetSize = Math.round(sampleRate / 10);
    this.packet = new Int16Array(this.packetSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      const clipped = Math.min(1, Math.max(-1, sample));
      this.packet[this.offset++] = clipped < 0 ? clipped * 32768 : clipped * 32767;
      if (this.offset === this.packetSize) {
        this.port.postMessage(this.packet.buffer, [this.packet.buffer]);
        this.packet = new Int16Array(this.packetSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('meeting-pcm', MeetingPcmProcessor);
