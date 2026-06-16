#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { parseDemo } from "./container.ts";
import { DEFAULT_RENDER, renderTopDown, renderMatch } from "./renderer.ts";
import { parseMeta } from "./meta.ts";
import { decodeDemo } from "./decoder.ts";
import { unwrapFastFile, scanStrings } from "./fastfile.ts";
import { encodeFrames, launchPlayback, detectFrameSequence } from "./capture.ts";

function usage(): never {
  console.error(
    [
      "cod4-dm1-tools — parse Call of Duty 4 .dm_1 demo files",
      "",
      "Usage:",
      "  dm1 info  <demo.dm_1>                   Print a summary of the demo",
      "  dm1 meta  <demo.dm_1>                   Show map, gametype and config strings",
      "  dm1 path  <demo.dm_1> [--out f]         Export the camera path as JSON",
      "  dm1 render <demo.dm_1> [--out v.mp4]    Render recorder's path video (mp4)",
      "  dm1 replay <demo.dm_1> [--out v.mp4]    Render full match replay, all players (mp4)",
      "  dm1 unwrap <file.ff> [--out zone.bin]   Decompress a FastFile and list assets",
      "  dm1 capture <demo.dm_1>                 Launch CoD4 to play the demo & dump frames",
      "  dm1 encode <screenshots-dir> --out v.mp4  Encode dumped game frames to mp4",
      "",
      "Options:",
      "  --out <file>     Output file (JSON for `path`, mp4 for `render`/`encode`)",
      "  --fps <n>        Output frame rate (render; default 60)",
      "  --frames <n>     Max output frames sampled across the demo (render; default 1800)",
      "  --width <n>      Video width (render; default 1280)",
      "  --height <n>     Video height (render; default 720)",
      "  --speed <n>      Replay playback speed multiplier (e.g. 30)",
      "  --map <img>      Replay: top-down map background image",
      "  --map-extent <minX,minY,maxX,maxY>  world rect the map image covers",
      "  --mod <path>     capture: fs_game mod dir (auto-detected from the demo path)",
      "  --windowed       capture: run the game windowed",
      "  --ext <ext>      encode: frame extension (default tga)",
      "  --crf <n>        encode: x264 quality, lower = better (default 18)",
    ].join("\n"),
  );
  process.exit(1);
}

function fmtVec(v: readonly number[]): string {
  return `[${v.map((n) => n.toFixed(1)).join(", ")}]`;
}

function cmdInfo(file: string): void {
  const buf = readFileSync(file);
  const { protocol, stats } = parseDemo(buf);

  console.log(`Demo:       ${basename(file)}`);
  console.log(`Size:       ${(stats.fileBytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`Protocol:   ${protocol ? protocol.protocol : "unknown"}`);
  console.log(`Frames:     ${stats.frameCount}  (camera path samples)`);
  console.log(`Snapshots:  ${stats.snapshotCount}  (compressed world state)`);
  console.log(`Duration:   ${(stats.durationMs / 1000).toFixed(1)} s`);
  console.log(`Avg FPS:    ${stats.fps}`);
  if (stats.bounds) {
    console.log(`Bounds min: ${fmtVec(stats.bounds.min)}`);
    console.log(`Bounds max: ${fmtVec(stats.bounds.max)}`);
  }
  console.log(`Clean EOF:  ${stats.cleanEof ? "yes" : "no"}`);
  if (stats.warnings.length) {
    console.log("Warnings:");
    for (const w of stats.warnings) console.log(`  - ${w}`);
  }
}

function cmdPath(file: string, out: string | null): void {
  const buf = readFileSync(file);
  const { protocol, frames, stats } = parseDemo(buf);
  const payload = {
    source: basename(file),
    protocol: protocol?.protocol ?? null,
    stats,
    frames,
  };
  const json = JSON.stringify(payload, null, out ? 0 : 2);
  if (out) {
    writeFileSync(out, json);
    console.error(`Wrote ${frames.length} frames to ${out}`);
  } else {
    console.log(json);
  }
}

function cmdMeta(file: string): void {
  const buf = readFileSync(file);
  const { protocol, snapshots } = parseDemo(buf, { keepSnapshotPayloads: true });
  const meta = parseMeta(snapshots, protocol?.protocol ?? 21);
  console.log(`Map:        ${meta.mapName ?? "unknown"}`);
  console.log(`Gametype:   ${meta.gametype ?? "unknown"}`);
  console.log(`Config strings: ${Object.keys(meta.configStrings).length}`);
  const si = meta.serverInfo;
  const interesting = ["sv_hostname", "g_gametype", "timescale", "version", "shortversion", "fs_game"];
  for (const k of interesting) if (si[k]) console.log(`  ${k}: ${si[k]}`);
  if (meta.serverCommands.length) {
    console.log(`Server commands (first 5 of ${meta.serverCommands.length}):`);
    for (const c of meta.serverCommands.slice(0, 5)) console.log(`  ${c.slice(0, 100)}`);
  }
}

async function cmdRender(file: string, flags: Map<string, string>): Promise<void> {
  const buf = readFileSync(file);
  const { frames, stats } = parseDemo(buf);
  const out = flags.get("out") ?? file.replace(/\.dm_1$/i, "") + ".mp4";
  const num = (k: string, d: number) => {
    const v = flags.get(k);
    return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d;
  };
  console.error(`Rendering ${frames.length} path samples -> ${out} ...`);
  await renderTopDown(frames, stats.bounds, {
    out,
    fps: num("fps", DEFAULT_RENDER.fps),
    maxFrames: num("frames", DEFAULT_RENDER.maxFrames),
    width: num("width", DEFAULT_RENDER.width),
    height: num("height", DEFAULT_RENDER.height),
    padding: DEFAULT_RENDER.padding,
  });
  console.error(`Done: ${out}`);
}

function parseExtent(s: string | undefined): [number, number, number, number] | undefined {
  if (!s) return undefined;
  const p = s.split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    throw new Error("--map-extent must be minX,minY,maxX,maxY");
  }
  return [p[0], p[1], p[2], p[3]];
}

async function cmdReplay(file: string, flags: Map<string, string>): Promise<void> {
  const buf = readFileSync(file);
  console.error("Decoding snapshots ...");
  const res = decodeDemo(buf);
  console.error(
    `Decoded ${res.snapshots.length} snapshots, ${Object.keys(res.clientNames).length} players, ${res.deaths.length} deaths.`,
  );
  const out = flags.get("out") ?? file.replace(/\.dm_1$/i, "") + ".replay.mp4";
  const num = (k: string, d: number) => {
    const v = flags.get(k);
    return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d;
  };
  await renderMatch(res.snapshots, res.clientNames, res.deaths, {
    out,
    fps: num("fps", DEFAULT_RENDER.fps),
    maxFrames: num("frames", 3600),
    width: num("width", DEFAULT_RENDER.width),
    height: num("height", DEFAULT_RENDER.height),
    padding: DEFAULT_RENDER.padding,
    speed: flags.has("speed") ? num("speed", 16) : undefined,
    seconds: flags.has("seconds") ? num("seconds", 90) : undefined,
    mapImage: flags.get("map"),
    mapExtent: parseExtent(flags.get("map-extent")),
  });
  console.error(`Done: ${out}`);
}

function cmdUnwrap(file: string, flags: Map<string, string>): void {
  const ff = unwrapFastFile(readFileSync(file));
  console.log(`Magic:      ${ff.magic}`);
  console.log(`Version:    ${ff.version}`);
  console.log(`Zone size:  ${(ff.zone.length / 1024 / 1024).toFixed(1)} MiB`);
  const out = flags.get("out");
  if (out) {
    writeFileSync(out, ff.zone);
    console.error(`Wrote zone to ${out}`);
  }
  const strs = scanStrings(ff.zone, 5);
  const uniq = (re: RegExp, n = 8) => [...new Set(strs.filter((s) => re.test(s)))].slice(0, n);
  console.log(`Strings:    ${strs.length}`);
  const compass = uniq(/^compass_map_/i, 3);
  const bsp = uniq(/\.d3dbsp$/i, 3);
  if (compass.length) console.log(`Compass:    ${compass.join(", ")}`);
  if (bsp.length) console.log(`BSP:        ${bsp.join(", ")}`);
}

async function cmdEncode(dir: string, flags: Map<string, string>): Promise<void> {
  const out = flags.get("out") ?? "out.mp4";
  const ext = flags.get("ext") ?? "tga";
  const num = (k: string, d: number) => {
    const v = flags.get(k);
    return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d;
  };
  const seq = detectFrameSequence(dir, ext);
  if (!seq) {
    console.error(`No numbered .${ext} frame sequence found in ${dir}.`);
    console.error(`(CoD4 dumps frames there after you run capture and press F9.)`);
    process.exit(1);
  }
  console.error(`Encoding ${seq.count} frames (${seq.pattern}) @ ${num("fps", 60)}fps -> ${out} ...`);
  const { frames } = await encodeFrames({
    dir,
    out,
    fps: num("fps", 60),
    ext,
    crf: num("crf", 18),
  });
  console.error(`Done: ${out} (${frames} frames)`);
}

/**
 * Infer the game dir and fs_game mod from a demo path. CoD4 demos live under
 * <gameDir>/<fs_game>/demos/<name>.dm_1 (e.g. Mods/fps_promod_277/demos). We
 * walk up from the demo to find the "demos" folder; its parent is the mod root
 * and the grandparent (above the mod root) is the game install.
 */
function inferGamePaths(demoPath: string): { gameDir: string; fsGame?: string; demoName: string } {
  const demoName = basename(demoPath).replace(/\.dm_1$/i, "");
  const demosDir = dirname(demoPath); // .../<fs_game>/demos
  const modRoot = dirname(demosDir); // .../<fs_game>  (or game/main)
  const parts = modRoot.split(sep);
  const gameDir = dirname(modRoot);
  // fs_game is the mod root relative to the game dir (e.g. "Mods/fps_promod_277").
  // If the mod root is literally "main", there is no fs_game override.
  const rel = parts.slice(-2).join("/"); // e.g. Mods/fps_promod_277
  const last = parts[parts.length - 1];
  const fsGame = last.toLowerCase() === "main" ? undefined : rel;
  return { gameDir, fsGame, demoName };
}

function cmdCapture(demoPath: string, flags: Map<string, string>): void {
  const inferred = inferGamePaths(demoPath);
  const fsGame = flags.get("mod") ?? inferred.fsGame;
  const gameDir = inferred.gameDir;
  const fps = Number(flags.get("fps") ?? 60) || 60;
  const fsGameDir = fsGame ? join(gameDir, fsGame) : join(gameDir, "main");

  console.error(`Game dir:   ${gameDir}`);
  console.error(`fs_game:    ${fsGame ?? "(main)"}`);
  console.error(`Demo:       ${inferred.demoName}`);
  console.error(`Launching CoD4 to play the demo ...`);

  const child = launchPlayback({
    gameDir,
    fsGame,
    demo: inferred.demoName,
    fps,
    windowed: flags.has("windowed"),
  });
  child.unref();

  const shotsDir = join(fsGameDir, "screenshots");
  console.error("");
  console.error("In-game capture controls (bound by the generated config):");
  console.error(`  F9  = start dumping frames at ${fps} fps`);
  console.error("  F10 = stop dumping frames");
  console.error("");
  console.error(`Frames are written as TGA to:\n  ${shotsDir}`);
  console.error("");
  console.error("When you're done, encode them to mp4 with:");
  console.error(`  node src/cli.ts encode "${shotsDir}" --out "${inferred.demoName}.mp4" --fps ${fps}`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, file, ...rest] = argv;
  if (!cmd || !file) usage();

  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) flags.set(rest[i].slice(2), rest[++i] ?? "");
  }
  const out = flags.get("out") ?? null;

  switch (cmd) {
    case "info":
      cmdInfo(file);
      break;
    case "meta":
      cmdMeta(file);
      break;
    case "path":
      cmdPath(file, out);
      break;
    case "render":
      await cmdRender(file, flags);
      break;
    case "replay":
      await cmdReplay(file, flags);
      break;
    case "unwrap":
      cmdUnwrap(file, flags);
      break;
    case "capture":
      cmdCapture(file, flags);
      break;
    case "encode":
      await cmdEncode(file, flags);
      break;
    default:
      usage();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
