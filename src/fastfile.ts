import { inflateSync } from "node:zlib";

/**
 * Phase 3a — FastFile (.ff) container unwrap.
 *
 * A CoD4 (IW3) FastFile is a 12-byte header followed by a single compressed
 * "zone" blob:
 *   bytes 0..7  magic, e.g. "IWffu100" (the 5th char is the compression type:
 *               'u' = zlib/inflate, '0' = uncompressed)
 *   bytes 8..11 little-endian version (5 for retail CoD4)
 *   bytes 12..  the zone (zlib stream for 'u')
 *
 * Parsing the *contents* of the zone (GfxWorld/XModel/Material structs) is the
 * large Phase 3b+ work — see docs/PHASE3-3D.md. This module only unwraps the
 * container and offers a string scan to locate assets.
 */
export interface FastFile {
  magic: string;
  compression: string;
  version: number;
  zone: Buffer;
}

export function unwrapFastFile(buf: Buffer): FastFile {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "IWff") {
    throw new Error("Not a FastFile (missing 'IWff' magic).");
  }
  const magic = buf.toString("latin1", 0, 8);
  const compression = magic[4];
  const version = buf.readUInt32LE(8);
  const body = buf.subarray(12);

  let zone: Buffer;
  if (compression === "u") {
    zone = inflateSync(body, { maxOutputLength: 512 * 1024 * 1024 });
  } else if (compression === "0") {
    zone = Buffer.from(body);
  } else {
    throw new Error(`Unsupported FastFile compression '${compression}' (magic ${magic}).`);
  }
  return { magic, compression, version, zone };
}

/**
 * Extract printable ASCII strings (length >= minLen) from the zone. Asset names
 * (e.g. "maps/mp/mp_crash.d3dbsp", "compass_map_mp_crash") are stored as
 * NUL-terminated C strings, so a simple scan surfaces them.
 */
export function scanStrings(zone: Buffer, minLen = 4): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= zone.length; i++) {
    const c = i < zone.length ? zone[i] : 0;
    const printable = c >= 0x20 && c < 0x7f;
    if (printable) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= minLen) out.push(zone.toString("latin1", start, i));
      start = -1;
    }
  }
  return out;
}
