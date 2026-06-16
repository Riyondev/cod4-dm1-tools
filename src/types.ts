/** Top-level message kinds in a .dm_1 stream (first byte of every record). */
export const MessageType = {
  Snapshot: 0,
  Frame: 1,
  Protocol: 2,
  Reliable: 3,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** A 3-component vector (origin, velocity, angles). */
export type Vec3 = [number, number, number];

/**
 * An archived client frame (the MSG_FRAME record).
 *
 * These records carry the *recording* player's own movement state, stored as
 * plain floats with no Huffman/delta compression — so they are decodable
 * without the full snapshot pipeline. This is the camera path of the demo.
 */
export interface ArchivedFrame {
  /** Server message sequence this frame is tied to. */
  serverMsgSeq: number;
  origin: Vec3;
  velocity: Vec3;
  movementDir: number;
  bobCycle: number;
  /** Client command time in ms — monotonically increasing playback clock. */
  commandTime: number;
  /** View angles [pitch, yaw, roll] in degrees. */
  angles: Vec3;
}

/** A snapshot record, currently captured at the container level only. */
export interface SnapshotRecord {
  serverMsgSeq: number;
  /** Size in bytes of the Huffman-compressed payload (excludes the dummy int). */
  payloadSize: number;
  /** Raw compressed payload bytes (kept for the upcoming snapshot decoder). */
  payload: Buffer;
}

/** Protocol header (MSG_PROTOCOL), normally the first record in the file. */
export interface ProtocolInfo {
  protocol: number;
  legacyEnd: number;
  reserved: bigint;
}

/** Result of a full container-level parse. */
export interface DemoParseResult {
  protocol: ProtocolInfo | null;
  frames: ArchivedFrame[];
  /** Lightweight snapshot index (payloads omitted unless `keepSnapshotPayloads`). */
  snapshots: SnapshotRecord[];
  stats: DemoStats;
}

export interface DemoStats {
  fileBytes: number;
  frameCount: number;
  snapshotCount: number;
  /** Playback duration in ms, derived from frame command times. */
  durationMs: number;
  /** Average frames-per-second derived from command-time deltas. */
  fps: number;
  /** Axis-aligned bounds of the camera path (useful for 2D render scaling). */
  bounds: { min: Vec3; max: Vec3 } | null;
  /** True if the file ended on the expected (-1) terminator. */
  cleanEof: boolean;
  /** Any non-fatal anomalies encountered while parsing. */
  warnings: string[];
}
