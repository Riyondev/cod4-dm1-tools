import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInfoString } from "../src/meta.ts";

test("parses a CoD4 backslash key/value info string", () => {
  const info = parseInfoString("\\mapname\\mp_crash\\g_gametype\\sd\\sv_maxclients\\20");
  assert.equal(info.mapname, "mp_crash");
  assert.equal(info.g_gametype, "sd");
  assert.equal(info.sv_maxclients, "20");
});

test("ignores empty leading/trailing segments", () => {
  const info = parseInfoString("\\a\\1\\");
  assert.deepEqual(info, { a: "1" });
});
