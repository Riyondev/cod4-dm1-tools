import { BinaryReader } from "./binaryReader.ts";
import {
  MessageType,
  type ArchivedFrame,
  type DemoParseResult,
  type DemoStats,
  type ProtocolInfo,
  type SnapshotRecord,
  type Vec3,
} from "./types.ts";

export interface ParseOptions {
  /** Keep the raw compressed snapshot payloads in memory (needed by the decoder). */
  keepSnapshotPayloads?: boolean;
}

/**
 * Parses the container layer of a .dm_1 demo: the sequence of length-framed
 * records (protocol / frame / snapshot). Frame records are fully decoded into
 * the camera path; snapshot payloads are indexed (and optionally retained) for
 * the separate Huffman+delta decoder.
 *
 * Port reference: Iswenzz/CoD4-DM1 `Demo::Next` / `ReadMessage` / `ReadArchive`
 * / `ReadProtocol`.
 */
export function parseDemo(buf: Buffer, opts: ParseOptions = {}): DemoParseResult {
  const r = new BinaryReader(buf);
  const frames: ArchivedFrame[] = [];
  const snapshots: SnapshotRecord[] = [];
  const warnings: string[] = [];
  let protocol: ProtocolInfo | null = null;
  let cleanEof = false;

  try {
  loop: while (!r.eof()) {
    const type = r.readUInt8() as MessageType;

    switch (type) {
      case MessageType.Snapshot: {
        // The terminator is a snapshot record whose sequence reads -1.
        const serverMsgSeq = r.readInt32();
        if (serverMsgSeq === -1) {
          cleanEof = true;
          break loop;
        }
        const curSize = r.readInt32();
        r.readInt32(); // dummy
        const payloadSize = curSize - 4; // the dummy int is excluded from payload
        if (payloadSize < 0 || payloadSize > r.remaining) {
          warnings.push(
            `Snapshot at offset ${r.position} declares payload size ${payloadSize} ` +
              `but only ${r.remaining} bytes remain; stopping.`,
          );
          break loop;
        }
        const payload = r.readBytes(payloadSize);
        snapshots.push({
          serverMsgSeq,
          payloadSize,
          payload: opts.keepSnapshotPayloads ? payload : Buffer.alloc(0),
        });
        break;
      }

      case MessageType.Frame: {
        const serverMsgSeq = r.readInt32();
        const origin: Vec3 = [r.readFloat(), r.readFloat(), r.readFloat()];
        const velocity: Vec3 = [r.readFloat(), r.readFloat(), r.readFloat()];
        const movementDir = r.readInt32();
        const bobCycle = r.readInt32();
        const commandTime = r.readInt32();
        const angles: Vec3 = [r.readFloat(), r.readFloat(), r.readFloat()];
        frames.push({ serverMsgSeq, origin, velocity, movementDir, bobCycle, commandTime, angles });
        break;
      }

      case MessageType.Protocol: {
        protocol = {
          protocol: r.readUInt32(),
          legacyEnd: r.readInt32(),
          reserved: r.readBigUInt64(),
        };
        break;
      }

      case MessageType.Reliable: {
        // Not present in standard recorded demos; its length is undefined here,
        // so continuing would desync the stream. Stop and report.
        warnings.push(`Encountered MSG_RELIABLE at offset ${r.position - 1}; cannot frame it, stopping.`);
        break loop;
      }

      default: {
        warnings.push(`Unknown message type ${type} at offset ${r.position - 1}; stopping.`);
        break loop;
      }
    }
  }
  } catch (err) {
    // Truncated or corrupt demo: stop cleanly and report rather than throwing.
    warnings.push(`Stopped early: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!cleanEof) {
    warnings.push("Demo did not end on the expected (-1) terminator.");
  }

  return {
    protocol,
    frames,
    snapshots,
    stats: computeStats(buf.length, frames, snapshots, cleanEof, warnings),
  };
}

function computeStats(
  fileBytes: number,
  frames: ArchivedFrame[],
  snapshots: SnapshotRecord[],
  cleanEof: boolean,
  warnings: string[],
): DemoStats {
  let durationMs = 0;
  let fps = 0;
  let bounds: { min: Vec3; max: Vec3 } | null = null;

  if (frames.length > 0) {
    let tMin = Infinity;
    let tMax = -Infinity;
    let timeSamples = 0;
    for (const f of frames) {
      if (f.commandTime > 0) {
        if (f.commandTime < tMin) tMin = f.commandTime;
        if (f.commandTime > tMax) tMax = f.commandTime;
        timeSamples++;
      }
    }
    if (timeSamples > 1) {
      durationMs = tMax - tMin;
      if (durationMs > 0) fps = ((frames.length - 1) * 1000) / durationMs;
    }

    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const f of frames) {
      for (let i = 0; i < 3; i++) {
        if (f.origin[i] < min[i]) min[i] = f.origin[i];
        if (f.origin[i] > max[i]) max[i] = f.origin[i];
      }
    }
    if (Number.isFinite(min[0])) bounds = { min, max };
  }

  return {
    fileBytes,
    frameCount: frames.length,
    snapshotCount: snapshots.length,
    durationMs,
    fps: Math.round(fps * 100) / 100,
    bounds,
    cleanEof,
    warnings,
  };
}
