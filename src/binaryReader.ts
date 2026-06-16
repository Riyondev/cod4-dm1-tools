/**
 * Little-endian byte reader over a Node Buffer.
 *
 * This operates at the *container* level of a .dm_1 file (whole bytes only).
 * Bit-level reading of the Huffman-compressed snapshot payloads is a separate
 * concern handled by the (upcoming) BitReader / Huffman module.
 */
export class BinaryReader {
  private offset = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get position(): number {
    return this.offset;
  }

  get length(): number {
    return this.buf.length;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  eof(): boolean {
    return this.offset >= this.buf.length;
  }

  /** Ensure `count` more bytes are available, otherwise throw a descriptive error. */
  private ensure(count: number): void {
    if (this.offset + count > this.buf.length) {
      throw new RangeError(
        `Unexpected end of demo: tried to read ${count} byte(s) at offset ${this.offset}, ` +
          `but only ${this.remaining} remain (file length ${this.buf.length}).`,
      );
    }
  }

  readUInt8(): number {
    this.ensure(1);
    return this.buf.readUInt8(this.offset++);
  }

  readInt8(): number {
    this.ensure(1);
    return this.buf.readInt8(this.offset++);
  }

  readInt32(): number {
    this.ensure(4);
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readUInt32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readFloat(): number {
    this.ensure(4);
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  readBigUInt64(): bigint {
    this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  /** Read `len` raw bytes and return a copy. */
  readBytes(len: number): Buffer {
    this.ensure(len);
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return Buffer.from(out);
  }

  /** Skip `len` bytes forward. */
  skip(len: number): void {
    this.ensure(len);
    this.offset += len;
  }
}
