export class SseReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}
  async nextFrame() {
    while (true) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator >= 0) {
        const frame = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 2);
        return frame;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SSE stream closed before the expected event");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
  async nextEvent(name: string): Promise<Record<string, unknown>> {
    while (true) {
      const frame = await this.nextFrame();
      if (frame.match(/^event: (.+)$/m)?.[1] !== name) continue;
      return JSON.parse(frame.match(/^data: (.+)$/m)![1]);
    }
  }
  async close() { await this.reader.cancel(); }
}
