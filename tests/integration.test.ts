import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseDemo } from "../src/container.ts";
import { parseMeta } from "../src/meta.ts";
import { decodeDemo } from "../src/decoder.ts";

// These run only when a real demo is supplied (copyrighted demos are never
// committed). Set DM1_TEST_DEMO=/path/to/Match_xxx.dm_1 to enable.
const demoPath = process.env.DM1_TEST_DEMO;
const opts = { skip: demoPath ? false : "set DM1_TEST_DEMO to a .dm_1 file to run" };

test("container parses a real demo to a clean EOF", opts, () => {
  const buf = readFileSync(demoPath!);
  const res = parseDemo(buf);
  assert.ok(res.frames.length > 1000, "expected many camera frames");
  assert.equal(res.stats.cleanEof, true);
  assert.ok(res.stats.fps > 100 && res.stats.fps < 260, `fps ${res.stats.fps} looks wrong`);
});

test("meta decodes a map name and gametype", opts, () => {
  const buf = readFileSync(demoPath!);
  const { protocol, snapshots } = parseDemo(buf, { keepSnapshotPayloads: true });
  const meta = parseMeta(snapshots, protocol?.protocol ?? 21);
  assert.match(meta.mapName ?? "", /^mp_/);
  assert.ok((meta.gametype ?? "").length > 0);
});

test("decoder yields players inside map bounds, teams, and deaths", opts, () => {
  const buf = readFileSync(demoPath!);
  const res = decodeDemo(buf);
  assert.ok(res.snapshots.length > 1000);

  let players = 0;
  const teams = new Set<number>();
  let minX = Infinity, maxX = -Infinity;
  for (const s of res.snapshots) {
    for (const e of s.entities) {
      if (e.eType !== 1) continue;
      players++;
      teams.add(e.team);
      minX = Math.min(minX, e.origin[0]);
      maxX = Math.max(maxX, e.origin[0]);
    }
  }
  assert.ok(players > 1000, "expected many player-entity instances");
  // Real maps span a few thousand units; guard against decode desync.
  assert.ok(maxX - minX > 100 && maxX - minX < 20000, `x-span ${maxX - minX} looks wrong`);
  assert.ok(teams.has(1) || teams.has(2), "expected team-tagged players");
  assert.ok(res.deaths.length > 0, "expected death events");
});
