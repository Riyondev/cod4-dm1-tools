import { spawn, type StdioOptions } from "node:child_process";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import ffmpegPath from "ffmpeg-static";
import type { ArchivedFrame, Vec3 } from "./types.ts";
import type { DecodedSnapshot, DeathEvent } from "./decoder.ts";

export interface RenderOptions {
  width: number;
  height: number;
  /** Output video frame rate. */
  fps: number;
  /** Max number of output frames; the demo is sampled evenly across this many. */
  maxFrames: number;
  out: string;
  /** Extra world-unit padding around the path bounds. */
  padding: number;
  /** Replay only: playback speed multiplier (e.g. 16 = 16x real time). */
  speed?: number;
  /** Replay only: target output duration in seconds (used if speed is unset). */
  seconds?: number;
  /** Optional top-down map background image (e.g. a compass_map overview). */
  mapImage?: string;
  /** World rectangle [minX, minY, maxX, maxY] the map image covers. */
  mapExtent?: [number, number, number, number];
}

export const DEFAULT_RENDER: Omit<RenderOptions, "out"> = {
  width: 1280,
  height: 720,
  fps: 60,
  maxFrames: 1800,
  padding: 128,
};

interface Projection {
  project(world: Vec3): [number, number];
}

/** Build a top-down (X/Y plane) projection that preserves aspect and centers the path. */
function makeProjection(
  bounds: { min: Vec3; max: Vec3 },
  w: number,
  h: number,
  pad: number,
): Projection {
  const minX = bounds.min[0] - pad;
  const minY = bounds.min[1] - pad;
  const worldW = bounds.max[0] - bounds.min[0] + pad * 2;
  const worldH = bounds.max[1] - bounds.min[1] + pad * 2;
  const scale = Math.min(w / worldW, h / worldH);
  const offX = (w - worldW * scale) / 2;
  const offY = (h - worldH * scale) / 2;
  return {
    project(world: Vec3): [number, number] {
      const sx = offX + (world[0] - minX) * scale;
      // World Y is "up"; flip to screen space (Y grows downward).
      const sy = h - (offY + (world[1] - minY) * scale);
      return [sx, sy];
    },
  };
}

/** Interpolate between two angles (degrees) along the shortest arc. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * t;
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Render a top-down time-lapse of the recording player's path to mp4.
 *
 * This is the Phase-1 renderer: it visualizes the camera path decoded from the
 * MSG_FRAME records. When the snapshot decoder lands, the same pipeline will
 * also draw every other player/entity.
 */
export async function renderTopDown(
  frames: ArchivedFrame[],
  bounds: { min: Vec3; max: Vec3 } | null,
  opts: RenderOptions,
): Promise<void> {
  if (!frames.length) throw new Error("No frames to render.");
  if (!bounds) throw new Error("Demo has no spatial bounds to render.");
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found.");

  const { width: W, height: H, fps, maxFrames, padding } = opts;
  const proj = makeProjection(bounds, W, H, padding);

  // Precompute screen-space points for the whole path.
  const pts: [number, number][] = frames.map((f) => proj.project(f.origin));

  // Detect teleports (killcam / respawn) so the trail doesn't draw spurious
  // straight lines across the map. A legit step at ~125 fps is only a few units.
  const TELEPORT_UNITS = 200;
  const breakBefore: boolean[] = new Array(frames.length).fill(false);
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1].origin;
    const b = frames[k].origin;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > TELEPORT_UNITS) breakBefore[k] = true;
  }

  // Persistent trail layer: each path segment is drawn exactly once.
  const trail = createCanvas(W, H);
  const tctx = trail.getContext("2d") as unknown as SKRSContext2D;
  tctx.fillStyle = "#0c1016";
  tctx.fillRect(0, 0, W, H);
  drawGrid(tctx, W, H);
  tctx.lineWidth = 2;
  tctx.strokeStyle = "rgba(80, 200, 255, 0.55)";
  tctx.lineCap = "round";
  tctx.lineJoin = "round";

  // Frame compositor.
  const frame = createCanvas(W, H);
  const fctx = frame.getContext("2d") as unknown as SKRSContext2D;

  const ff = spawn(ffmpegPath as unknown as string, [
    "-y",
    "-f", "image2pipe",
    "-framerate", String(fps),
    "-i", "pipe:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    opts.out,
  ], { stdio: ["pipe", "ignore", "inherit"] as StdioOptions });

  const ffStdin = ff.stdin;
  if (!ffStdin) throw new Error("Failed to open ffmpeg stdin pipe.");

  const ffDone = new Promise<void>((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)),
    );
  });

  const total = Math.min(maxFrames, frames.length);
  const startTime = frames[0].commandTime;
  let lastIdx = 0;

  for (let i = 0; i < total; i++) {
    // Map output frame i -> index into the decoded path (even sampling).
    const curIdx = Math.round((i / (total - 1 || 1)) * (frames.length - 1));

    // Extend the persistent trail up to curIdx.
    if (curIdx > lastIdx) {
      tctx.beginPath();
      tctx.moveTo(pts[lastIdx][0], pts[lastIdx][1]);
      for (let k = lastIdx + 1; k <= curIdx; k++) {
        if (breakBefore[k]) tctx.moveTo(pts[k][0], pts[k][1]);
        else tctx.lineTo(pts[k][0], pts[k][1]);
      }
      tctx.stroke();
      lastIdx = curIdx;
    }

    // Composite: trail + current marker + HUD.
    fctx.drawImage(trail, 0, 0);
    drawMarker(fctx, pts[curIdx], frames[curIdx].angles[1]);
    drawHud(fctx, W, H, frames[curIdx], startTime, i, total);

    await writeToStream(ffStdin, frame.toBuffer("image/png"));
  }

  ffStdin.end();
  await ffDone;
}

function drawGrid(ctx: SKRSContext2D, w: number, h: number): void {
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  const step = 64;
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawMarker(ctx: SKRSContext2D, p: [number, number], yawDeg: number): void {
  const [x, y] = p;
  // Heading arrow. CoD yaw: 0 = +X, increasing CCW; screen Y is flipped.
  const yaw = (yawDeg * Math.PI) / 180;
  const dx = Math.cos(yaw);
  const dy = -Math.sin(yaw);
  const len = 22;
  ctx.strokeStyle = "#ffd166";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + dx * len, y + dy * len);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#ff5252";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
}

function drawHud(
  ctx: SKRSContext2D,
  w: number,
  h: number,
  f: ArchivedFrame,
  startTime: number,
  frameIdx: number,
  totalFrames: number,
): void {
  ctx.font = "16px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.textBaseline = "top";
  ctx.fillText(`t ${fmtClock(f.commandTime - startTime)}`, 14, 12);
  const speed = Math.hypot(f.velocity[0], f.velocity[1]);
  ctx.fillText(`speed ${speed.toFixed(0)} u/s`, 14, 34);

  // Progress bar.
  const pw = w - 28;
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.fillRect(14, h - 22, pw, 6);
  ctx.fillStyle = "#50c8ff";
  ctx.fillRect(14, h - 22, (pw * (frameIdx + 1)) / totalFrames, 6);
}

function writeToStream(stream: NodeJS.WritableStream, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

function spawnFfmpeg(out: string, fps: number) {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found.");
  const ff = spawn(ffmpegPath as unknown as string, [
    "-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
  ], { stdio: ["pipe", "ignore", "inherit"] as StdioOptions });
  const stdin = ff.stdin;
  if (!stdin) throw new Error("Failed to open ffmpeg stdin pipe.");
  const done = new Promise<void>((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)),
    );
  });
  return { stdin, done };
}

// Distinct colors per client slot.
const PLAYER_COLORS = [
  "#ff5252", "#4fc3f7", "#ffd54f", "#81c784", "#ba68c8", "#ff8a65", "#4dd0e1", "#f06292",
  "#aed581", "#7986cb", "#ffb74d", "#a1887f", "#90a4ae", "#e57373", "#64b5f6", "#fff176",
];

const ET_PLAYER = 1;

const TEAM_RED = "#ff4d4d";
const TEAM_BLUE = "#4d9bff";
/** Team-based color (red/blue), falling back to a per-client color. */
function teamColor(team: number, clientNum: number): string {
  if (team === 1) return TEAM_RED;
  if (team === 2) return TEAM_BLUE;
  return PLAYER_COLORS[clientNum % PLAYER_COLORS.length];
}
function teamRGB(team: number): [number, number, number] {
  if (team === 1) return [255, 77, 77];
  if (team === 2) return [77, 155, 255];
  return [200, 200, 200];
}

/**
 * Render a top-down match replay (all players) to mp4 from decoded snapshots.
 * Players are drawn as colored dots with a short motion trail and heading.
 */
export async function renderMatch(
  snapshots: DecodedSnapshot[],
  names: Record<number, { name: string; clantag: string }>,
  deaths: DeathEvent[],
  opts: RenderOptions,
): Promise<void> {
  if (!snapshots.length) throw new Error("No decoded snapshots to render.");
  const { width: W, height: H, fps, maxFrames, padding } = opts;

  // Bounds from all player origins.
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of snapshots) {
    for (const e of s.entities) {
      if (e.eType !== ET_PLAYER) continue;
      for (let i = 0; i < 2; i++) {
        if (e.origin[i] < min[i]) min[i] = e.origin[i];
        if (e.origin[i] > max[i]) max[i] = e.origin[i];
      }
    }
  }
  if (!Number.isFinite(min[0])) throw new Error("No player entities found to render.");
  min[2] = 0;
  max[2] = 0;

  // If a calibrated map extent is given, project to it so players align to the
  // background image; otherwise fit to the players' own movement bounds.
  if (opts.mapExtent) {
    min[0] = opts.mapExtent[0];
    min[1] = opts.mapExtent[1];
    max[0] = opts.mapExtent[2];
    max[1] = opts.mapExtent[3];
  }
  const proj = makeProjection({ min, max }, W, H, opts.mapExtent ? 0 : padding);

  const mapImg = opts.mapImage ? await loadImage(opts.mapImage) : null;
  // Screen rectangle the map image occupies (world top-left -> bottom-right).
  let mapRect: [number, number, number, number] | null = null;
  if (mapImg) {
    const [tlx, tly] = proj.project([min[0], max[1], 0]);
    const [brx, bry] = proj.project([max[0], min[1], 0]);
    mapRect = [tlx, tly, brx - tlx, bry - tly];
  }

  const frame = createCanvas(W, H);
  const ctx = frame.getContext("2d") as unknown as SKRSContext2D;

  // Recent positions per client for trails.
  const trails = new Map<number, [number, number][]>();
  const TRAIL_LEN = 12;

  // Time-based playback: serverTime is strictly monotonic, so we can sample at
  // a fixed wall-clock cadence and interpolate players between snapshots.
  const times = snapshots.map((s) => s.serverTime);
  const startTime = times[0];
  const endTime = times[times.length - 1];
  const demoSec = (endTime - startTime) / 1000;
  const speed = opts.speed ?? demoSec / (opts.seconds ?? 90);
  const total = Math.max(1, Math.min(maxFrames * 20, Math.ceil((demoSec / speed) * fps)));
  const msPerFrame = (1000 / fps) * speed;
  // Snapshots more than this far apart are round breaks — don't interpolate across.
  const MAX_INTERP_GAP = 500;

  const { stdin, done } = spawnFfmpeg(opts.out, fps);
  let searchIdx = 0;
  const DEATH_FADE = 1500; // ms of game time a death marker stays visible
  let deathWinStart = 0;
  let deathCount = 0;

  for (let i = 0; i < total; i++) {
    const target = startTime + i * msPerFrame;
    // Advance to the snapshot pair straddling `target`.
    while (searchIdx < times.length - 1 && times[searchIdx + 1] <= target) searchIdx++;
    const a = snapshots[searchIdx];
    const b = snapshots[Math.min(searchIdx + 1, snapshots.length - 1)];
    const span = b.serverTime - a.serverTime;
    const frac = span > 0 && span <= MAX_INTERP_GAP ? Math.min(1, (target - a.serverTime) / span) : 0;
    const bByNum = new Map<number, (typeof b.entities)[number]>();
    for (const e of b.entities) if (e.eType === ET_PLAYER) bByNum.set(e.number, e);

    ctx.fillStyle = "#0c1016";
    ctx.fillRect(0, 0, W, H);
    if (mapImg && mapRect) ctx.drawImage(mapImg, mapRect[0], mapRect[1], mapRect[2], mapRect[3]);
    else drawGrid(ctx, W, H);

    // Death markers (fading X at recent corpse spawns).
    while (deathCount < deaths.length && deaths[deathCount].time <= target) deathCount++;
    while (deathWinStart < deaths.length && deaths[deathWinStart].time < target - DEATH_FADE) deathWinStart++;
    for (let di = deathWinStart; di < deaths.length && deaths[di].time <= target; di++) {
      const alpha = Math.max(0, 1 - (target - deaths[di].time) / DEATH_FADE);
      const [dx, dy] = proj.project(deaths[di].origin);
      const r2 = 5 + (1 - alpha) * 7;
      const [r, g, b] = teamRGB(deaths[di].victimTeam);
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(dx - r2, dy - r2);
      ctx.lineTo(dx + r2, dy + r2);
      ctx.moveTo(dx + r2, dy - r2);
      ctx.lineTo(dx - r2, dy + r2);
      ctx.stroke();
    }

    let alive = 0;
    let aliveRed = 0;
    let aliveBlue = 0;
    for (const e of a.entities) {
      if (e.eType !== ET_PLAYER) continue;
      alive++;
      if (e.team === 1) aliveRed++;
      else if (e.team === 2) aliveBlue++;
      const eb = bByNum.get(e.number);
      const ox = eb ? e.origin[0] + (eb.origin[0] - e.origin[0]) * frac : e.origin[0];
      const oy = eb ? e.origin[1] + (eb.origin[1] - e.origin[1]) * frac : e.origin[1];
      const oz = eb ? e.origin[2] + (eb.origin[2] - e.origin[2]) * frac : e.origin[2];
      const yawDeg = eb ? lerpAngle(e.yaw, eb.yaw, frac) : e.yaw;
      const [x, y] = proj.project([ox, oy, oz]);
      const color = teamColor(e.team, e.clientNum);

      let tr = trails.get(e.clientNum) ?? [];
      // Break the trail on respawn/teleport jumps so we don't streak across the map.
      const prev = tr[tr.length - 1];
      if (prev && Math.hypot(x - prev[0], y - prev[1]) > 90) tr = [];
      tr.push([x, y]);
      while (tr.length > TRAIL_LEN) tr.shift();
      trails.set(e.clientNum, tr);
      if (tr.length > 1) {
        ctx.strokeStyle = color + "66";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tr[0][0], tr[0][1]);
        for (let k = 1; k < tr.length; k++) ctx.lineTo(tr[k][0], tr[k][1]);
        ctx.stroke();
      }

      const yaw = (yawDeg * Math.PI) / 180;
      ctx.strokeStyle = "#ffffffcc";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(yaw) * 14, y - Math.sin(yaw) * 14);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#000";
      ctx.stroke();

      const label = names[e.clientNum]?.name?.replace(/\^\d/g, "") ?? `#${e.clientNum}`;
      ctx.font = "11px sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 9, y);
    }

    ctx.font = "16px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.textBaseline = "top";
    ctx.fillText(`t ${fmtClock(target - startTime)}  ${speed.toFixed(0)}x`, 14, 12);
    ctx.fillStyle = TEAM_RED;
    ctx.fillText(`● ${aliveRed}`, 14, 34);
    ctx.fillStyle = TEAM_BLUE;
    ctx.fillText(`● ${aliveBlue}`, 64, 34);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillText(`alive ${alive}   deaths ${deathCount}`, 110, 34);
    const pw = W - 28;
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fillRect(14, H - 22, pw, 6);
    ctx.fillStyle = "#50c8ff";
    ctx.fillRect(14, H - 22, (pw * (i + 1)) / total, 6);

    // Fading kill feed (recent deaths, victim name in team color), top-right.
    const FEED_TIME = 6000;
    ctx.font = "13px sans-serif";
    ctx.textAlign = "right";
    let fy = 12;
    for (let k = deathCount - 1; k >= 0 && k > deathCount - 12; k--) {
      const dd = deaths[k];
      const age = target - dd.time;
      if (age > FEED_TIME) break;
      if (dd.victimClient < 0) continue; // only show attributed deaths
      const a2 = Math.max(0, 1 - age / FEED_TIME);
      const [r, g, b] = teamRGB(dd.victimTeam);
      const nm = dd.victimName.replace(/\^\d/g, "") || `#${dd.victimClient}`;
      ctx.fillStyle = `rgba(${r},${g},${b},${a2.toFixed(3)})`;
      ctx.fillText(`× ${nm}`, W - 14, fy);
      fy += 18;
    }
    ctx.textAlign = "left";

    await writeToStream(stdin, frame.toBuffer("image/png"));
  }
  stdin.end();
  await done;
}
