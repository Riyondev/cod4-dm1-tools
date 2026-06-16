import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDemo } from "../src/container.ts";
import { MessageType } from "../src/types.ts";

/** Build a minimal synthetic .dm_1 byte stream: protocol + 2 frames + EOF. */
function buildSyntheticDemo(): Buffer {
  const parts: Buffer[] = [];

  // MSG_PROTOCOL: type, uint32 protocol, int legacyEnd, uint64 reserved
  const proto = Buffer.alloc(1 + 4 + 4 + 8);
  proto.writeUInt8(MessageType.Protocol, 0);
  proto.writeUInt32LE(21, 1);
  proto.writeInt32LE(0, 5);
  proto.writeBigUInt64LE(0n, 9);
  parts.push(proto);

  // Two MSG_FRAME records: type, int seq, 3f origin, 3f vel, 3*int, 3f angles
  for (let i = 0; i < 2; i++) {
    const f = Buffer.alloc(1 + 4 + 12 + 12 + 12 + 12);
    let o = 0;
    f.writeUInt8(MessageType.Frame, o); o += 1;
    f.writeInt32LE(i, o); o += 4;
    f.writeFloatLE(100 + i, o); o += 4; // origin x
    f.writeFloatLE(200 - i, o); o += 4; // origin y
    f.writeFloatLE(50, o); o += 4; // origin z
    f.writeFloatLE(1, o); o += 4; f.writeFloatLE(2, o); o += 4; f.writeFloatLE(3, o); o += 4; // velocity
    f.writeInt32LE(7, o); o += 4; // movementDir
    f.writeInt32LE(8, o); o += 4; // bobCycle
    f.writeInt32LE(1000 + i * 8, o); o += 4; // commandTime
    f.writeFloatLE(10, o); o += 4; f.writeFloatLE(45 + i, o); o += 4; f.writeFloatLE(0, o); o += 4; // angles
    parts.push(f);
  }

  // Terminator: MSG_SNAPSHOT type + int seq=-1
  const term = Buffer.alloc(1 + 4);
  term.writeUInt8(MessageType.Snapshot, 0);
  term.writeInt32LE(-1, 1);
  parts.push(term);

  return Buffer.concat(parts);
}

test("parses protocol, frames and clean EOF from a synthetic demo", () => {
  const res = parseDemo(buildSyntheticDemo());
  assert.equal(res.protocol?.protocol, 21);
  assert.equal(res.frames.length, 2);
  assert.equal(res.stats.cleanEof, true);
  assert.equal(res.stats.warnings.length, 0);
});

test("decodes frame fields correctly", () => {
  const res = parseDemo(buildSyntheticDemo());
  const f0 = res.frames[0];
  assert.deepEqual(f0.origin, [100, 200, 50]);
  assert.deepEqual(f0.velocity, [1, 2, 3]);
  assert.equal(f0.movementDir, 7);
  assert.equal(f0.commandTime, 1000);
  assert.equal(res.frames[1].origin[0], 101);
});

test("computes bounds and duration from frames", () => {
  const res = parseDemo(buildSyntheticDemo());
  assert.ok(res.stats.bounds);
  assert.deepEqual(res.stats.bounds!.min, [100, 199, 50]);
  assert.deepEqual(res.stats.bounds!.max, [101, 200, 50]);
  assert.equal(res.stats.durationMs, 8);
});

test("flags truncated input without a terminator", () => {
  const full = buildSyntheticDemo();
  const truncated = full.subarray(0, full.length - 2); // chop the EOF
  const res = parseDemo(truncated);
  assert.equal(res.stats.cleanEof, false);
  assert.ok(res.stats.warnings.length > 0);
});
