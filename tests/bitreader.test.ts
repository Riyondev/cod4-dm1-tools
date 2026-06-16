import { test } from "node:test";
import assert from "node:assert/strict";
import { BitReader } from "../src/bitReader.ts";

const reader = (bytes: number[], protocol = 21) => {
  const buf = Buffer.from(bytes);
  return new BitReader(buf, buf.length, protocol);
};

test("reads little-endian byte/short/int", () => {
  assert.equal(reader([0xab]).readByte(), 0xab);
  assert.equal(reader([0x34, 0x12]).readShort(), 0x1234);
  assert.equal(reader([0x01, 0x02, 0x03, 0x04]).readInt(), 0x04030201);
});

test("reads bits LSB-first", () => {
  const r = reader([0b00000101]);
  assert.equal(r.readBit(), 1);
  assert.equal(r.readBit(), 0);
  assert.equal(r.readBit(), 1);
  assert.equal(r.readBit(), 0);
});

test("readBits accumulates LSB-first", () => {
  assert.equal(reader([0b00000101]).readBits(3), 5);
  assert.equal(reader([0xff]).readBits(8), 255);
});

test("readByte realigns to the next byte after partial bit reads", () => {
  const r = reader([0x01, 0xab]);
  assert.equal(r.readBit(), 1); // consume one bit of byte 0
  assert.equal(r.readByte(), 0xab); // next byte, not the rest of byte 0
});

test("readString stops at NUL", () => {
  assert.equal(reader([104, 105, 0, 120]).readString(), "hi");
});

test("readAngle16 maps a 16-bit short to degrees", () => {
  // 0x4000 = 16384 -> 16384 * 360/65536 = 90
  assert.equal(reader([0x00, 0x40]).readAngle16(), 90);
});

test("sets overflowed past the end instead of throwing", () => {
  const r = reader([0x01]);
  r.readByte();
  assert.equal(r.readByte(), -1);
  assert.equal(r.overflowed, true);
});
