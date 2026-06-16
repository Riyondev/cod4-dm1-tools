import { BitReader } from "./bitReader.ts";
import type { SnapshotRecord } from "./types.ts";

/** svc_ops_e opcodes (see Iswenzz/CoD4-DM1 Msg.hpp). */
const SVC = {
  nop: 0,
  gamestate: 1,
  configstring: 2,
  baseline: 3,
  serverCommand: 4,
  download: 5,
  snapshot: 6,
  EOF: 7,
  configclient: 11,
} as const;

const MAX_CONFIGSTRINGS = 2 * 2442;

export interface DemoMeta {
  /** Non-empty config strings by index. */
  configStrings: Record<number, string>;
  /** Parsed key/values from the serverinfo config string, if found. */
  serverInfo: Record<string, string>;
  /** Server command strings seen before the (not-yet-decoded) snapshot blocks. */
  serverCommands: string[];
  /** Best-effort map name and gametype extracted from config data. */
  mapName: string | null;
  gametype: string | null;
}

/** Parse a CoD4 `\key\value\...` info string. */
export function parseInfoString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = s.split("\\").filter((p) => p.length > 0);
  for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}

function parseGamestateX(r: BitReader, cs: Record<number, string>): void {
  r.readInt(); // serverCommandSequence
  for (;;) {
    const cmd = r.readByte();
    if (cmd === SVC.EOF || cmd === -1) break;

    if (cmd === SVC.configstring) {
      let count = r.readInt();
      if (count < 0 || count >= 2 * MAX_CONFIGSTRINGS) break;
      while (count > 0 && !r.overflowed) {
        const idx = r.readInt();
        const s = r.readString();
        if (idx >= 0 && idx < 2 * MAX_CONFIGSTRINGS && s.length > 0) cs[idx] = s;
        count--;
      }
    } else if (cmd === SVC.configclient) {
      r.readByte();
      r.readString();
      r.readString();
    } else {
      // svc_baseline and anything else require the net-field decoder; stop here.
      break;
    }
    if (r.overflowed) break;
  }
}

/**
 * Extract demo metadata (config strings, map, gametype, early server commands)
 * by Huffman-decompressing snapshot messages and parsing the gamestate. Does
 * not require the full net-field entity decoder.
 */
export function parseMeta(snapshots: SnapshotRecord[], protocol: number): DemoMeta {
  const configStrings: Record<number, string> = {};
  const serverCommands: string[] = [];
  let gotGamestate = false;

  for (const snap of snapshots) {
    if (!snap.payload.length) continue;
    const r = BitReader.fromCompressed(snap.payload, protocol);

    for (;;) {
      if (r.readCount > r.curSize) break;
      const cmd = r.readByte();
      if (cmd === SVC.EOF || cmd === -1) break;

      if (cmd === SVC.gamestate) {
        parseGamestateX(r, configStrings);
        gotGamestate = true;
        break; // rest of this message needs the entity decoder
      } else if (cmd === SVC.serverCommand) {
        r.readInt();
        const s = r.readString();
        if (s.length) serverCommands.push(s);
      } else {
        break; // snapshot / config data we can't decode yet
      }
      if (r.overflowed) break;
    }
    // The gamestate appears once, early; stop scanning after a reasonable window.
    if (gotGamestate && serverCommands.length > 64) break;
  }

  // Locate serverinfo (the info string is the config string containing \mapname\).
  let serverInfo: Record<string, string> = {};
  let mapName: string | null = null;
  let gametype: string | null = null;
  for (const [, v] of Object.entries(configStrings)) {
    if (v.includes("\\mapname\\") || v.includes("\\g_gametype\\") || v.includes("\\gametype\\")) {
      const info = parseInfoString(v);
      serverInfo = { ...serverInfo, ...info };
      mapName = info.mapname ?? mapName;
      gametype = info.g_gametype ?? info.gametype ?? gametype;
    }
  }
  // Fallback: scan any config string for an mp_ map token.
  if (!mapName) {
    for (const v of Object.values(configStrings)) {
      const m = v.match(/\bmp_[a-z0-9_]+/i);
      if (m) {
        mapName = m[0];
        break;
      }
    }
  }

  return { configStrings, serverInfo, serverCommands, mapName, gametype };
}
