import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { unwrapFastFile, scanStrings } from "../src/fastfile.ts";

function buildFF(magic: string, version: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.write(magic, 0, "latin1");
  head.writeUInt32LE(version, 8);
  const body = magic[4] === "u" ? deflateSync(payload) : payload;
  return Buffer.concat([head, body]);
}

test("unwraps a zlib-compressed FastFile", () => {
  const payload = Buffer.from("hello\0maps/mp/test.d3dbsp\0compass_map_mp_test\0");
  const ff = unwrapFastFile(buildFF("IWffu100", 5, payload));
  assert.equal(ff.magic, "IWffu100");
  assert.equal(ff.compression, "u");
  assert.equal(ff.version, 5);
  assert.deepEqual(ff.zone, payload);
});

test("unwraps an uncompressed FastFile", () => {
  const payload = Buffer.from("raw zone bytes here");
  const ff = unwrapFastFile(buildFF("IWff0100", 5, payload));
  assert.equal(ff.compression, "0");
  assert.deepEqual(ff.zone, payload);
});

test("scanStrings finds NUL-terminated asset names", () => {
  const payload = Buffer.from("\x01\x02maps/mp/test.d3dbsp\x00xx\x00compass_map_mp_test\x00");
  const strs = scanStrings(payload, 5);
  assert.ok(strs.includes("maps/mp/test.d3dbsp"));
  assert.ok(strs.includes("compass_map_mp_test"));
  assert.ok(!strs.includes("xx")); // shorter than minLen
});

test("rejects non-FastFile input", () => {
  assert.throws(() => unwrapFastFile(Buffer.from("not a fastfile")), /IWff/);
});
