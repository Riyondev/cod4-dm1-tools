import { huffmanDecompress } from "./huffman.ts";

const NETCHAN_MAXBUFFER_SIZE = 0x20000 * 10;

/**
 * Bit/byte reader over a Huffman-decompressed message buffer.
 * Faithful port of Iswenzz/CoD4-DM1 `Crypt/Msg.cpp` read side. Bit reads and
 * byte reads share the same `readCount` cursor exactly as the original does.
 */
export class BitReader {
  buffer: Buffer;
  curSize: number;
  readCount = 0;
  bit = 0;
  overflowed = false;
  protocol: number;
  lastRefEntity = 0;

  constructor(buffer: Buffer, curSize: number, protocol: number) {
    this.buffer = buffer;
    this.curSize = curSize;
    this.protocol = protocol;
  }

  /** Build a reader from a compressed payload by Huffman-decompressing it. */
  static fromCompressed(payload: Buffer, protocol: number): BitReader {
    const out = huffmanDecompress(payload, payload.length, NETCHAN_MAXBUFFER_SIZE);
    return new BitReader(out, out.length, protocol);
  }

  readBit(): number {
    const oldbit7 = this.bit & 7;
    if (!oldbit7) {
      if (this.readCount >= this.curSize) {
        this.overflowed = true;
        return -1;
      }
      this.bit = 8 * this.readCount;
      this.readCount++;
    }
    const numBytes = this.bit >> 3;
    const bits = this.buffer[numBytes] >> oldbit7;
    this.bit++;
    return bits & 1;
  }

  readBits(numBits: number): number {
    let retval = 0;
    for (let i = 0; i < numBits; i++) {
      if (!(this.bit & 7)) {
        if (this.readCount >= this.curSize) {
          this.overflowed = true;
          return -1;
        }
        this.bit = 8 * this.readCount;
        this.readCount++;
      }
      const v = this.buffer[this.bit >> 3];
      retval |= ((v >> (this.bit & 7)) & 1) << i;
      this.bit++;
    }
    return retval;
  }

  readByte(): number {
    if (this.readCount + 1 > this.curSize) {
      this.overflowed = true;
      return -1;
    }
    return this.buffer[this.readCount++];
  }

  readShort(): number {
    if (this.readCount + 2 > this.curSize) {
      this.overflowed = true;
      return -1;
    }
    const v = this.buffer.readInt16LE(this.readCount);
    this.readCount += 2;
    return v;
  }

  readInt(): number {
    if (this.readCount + 4 > this.curSize) {
      this.overflowed = true;
      return -1;
    }
    const v = this.buffer.readInt32LE(this.readCount);
    this.readCount += 4;
    return v;
  }

  readFloat(): number {
    if (this.readCount + 4 > this.curSize) {
      this.overflowed = true;
      return -1;
    }
    const v = this.buffer.readFloatLE(this.readCount);
    this.readCount += 4;
    return v;
  }

  readString(): string {
    const bytes: number[] = [];
    for (;;) {
      const c = this.readByte();
      if (c === -1 || c === 0) break;
      bytes.push(c);
    }
    return Buffer.from(bytes).toString("latin1");
  }

  readAngle16(): number {
    return this.readShort() * (360 / 65536);
  }

  /** CoD4X (protocol > 17) sends origin components as raw 32-bit floats. */
  readOriginFloat(_bits: number, oldValue: number): number {
    if (this.protocol > 17) return this.readFloat();
    if (this.readBit()) {
      // Legacy map-center-relative path (unused for protocol 21 demos).
      return this.readBits(16);
    }
    return this.readBits(7) - 64 + oldValue;
  }

  readOriginZFloat(oldValue: number): number {
    return this.readOriginFloat(0, oldValue);
  }

  /** Abort the current message (port of Msg::Discard). */
  discard(): void {
    this.curSize = this.readCount;
    this.overflowed = true;
  }
}
