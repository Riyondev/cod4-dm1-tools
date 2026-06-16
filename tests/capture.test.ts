import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectFrameSequence, buildCaptureConfig } from "../src/capture.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dm1-cap-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("detects a zero-padded frame sequence", () => {
  withTempDir((dir) => {
    for (const n of [0, 1, 2, 3]) {
      writeFileSync(join(dir, `shot${String(n).padStart(4, "0")}.tga`), "x");
    }
    const seq = detectFrameSequence(dir, "tga");
    assert.ok(seq);
    assert.equal(seq.pattern, "shot%04d.tga");
    assert.equal(seq.start, 0);
    assert.equal(seq.count, 4);
    assert.equal(seq.ext, "tga");
  });
});

test("stops the run at the first gap", () => {
  withTempDir((dir) => {
    for (const n of [0, 1, 2, 5, 6]) {
      writeFileSync(join(dir, `shot${String(n).padStart(4, "0")}.tga`), "x");
    }
    const seq = detectFrameSequence(dir, "tga");
    assert.ok(seq);
    assert.equal(seq.start, 0);
    assert.equal(seq.count, 3); // 0,1,2 then gap before 5
  });
});

test("returns null when no matching frames exist", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "notes.txt"), "x");
    assert.equal(detectFrameSequence(dir, "tga"), null);
  });
});

test("honours a custom extension", () => {
  withTempDir((dir) => {
    for (const n of [0, 1]) writeFileSync(join(dir, `frame${String(n).padStart(6, "0")}.jpg`), "x");
    const seq = detectFrameSequence(dir, "jpg");
    assert.ok(seq);
    assert.equal(seq.pattern, "frame%06d.jpg");
    assert.equal(seq.count, 2);
  });
});

test("capture config binds F9/F10 and sets the dump rate", () => {
  const cfg = buildCaptureConfig(60);
  assert.match(cfg, /bind F9 "cl_avidemo 60"/);
  assert.match(cfg, /bind F10 "cl_avidemo 0"/);
  assert.match(cfg, /com_maxfps "60"/);
});
