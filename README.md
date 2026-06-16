# cod4-dm1-tools

Parse, inspect, decode, and render **Call of Duty 4** `.dm_1` demo recordings from Node.js.

`cod4-dm1-tools` is a TypeScript toolkit for working with CoD4 multiplayer demo files. It understands the demo container, decodes snapshot metadata and player state, exports camera paths, renders tactical top-down replay videos, and can drive a local CoD4 install to capture true first-person engine-rendered footage.

The project does **not** ship Call of Duty assets, maps, demos, or proprietary game files.

## Highlights

- Parse `.dm_1` demo containers with strict bounds checks and clean EOF validation.
- Decode archived camera frames: origin, velocity, view angles, movement direction, and command time.
- Decode Huffman-compressed gamestate and world snapshots.
- Recover map name, gametype, config strings, server info, player names, teams, positions, and death markers.
- Render asset-free top-down videos directly to `.mp4`.
- Render full tactical match replays with player labels, team colors, trails, death markers, kill feed, alive counts, speed control, and optional map overlays.
- Launch CoD4 to play a demo and dump frames for true game-quality footage.
- Encode dumped game frames to H.264 `.mp4` using bundled ffmpeg.
- Unwrap CoD4 FastFiles enough to inflate zone data and scan asset names.

## Status

Current version: **0.1.0**

Working today:

- Container parser
- Camera path export
- Metadata decode
- Snapshot/player decode
- Tactical path renderer
- Full match replay renderer
- Game-quality capture launcher
- Frame sequence encoder
- FastFile unwrap/string scan
- Unit tests and optional real-demo integration tests

Not implemented yet:

- Standalone no-game 3D rendering
- Full `GfxWorld` / `XModel` / material parsing
- Automatic extraction/calibration of map overview images

## Why This Exists

A `.dm_1` file is **not a video**. It is a recording of network state: snapshots, entities, player states, config strings, and the recording client's camera movement. To turn a demo into pixels, something has to replay and render that state.

This project gives you two practical paths:

1. **Asset-free tactical replay**

   Parse the demo directly and render a top-down 2D replay. This works without a game install and without game assets.

2. **Game-quality capture**

   Let your own installed copy of CoD4 render the demo through `iw3mp.exe`, dump frames with `cl_avidemo`, then encode those frames to mp4.

## Requirements

- Node.js **22 or newer**
- npm
- A `.dm_1` demo file for real usage
- Optional: Call of Duty 4 installed locally for `capture`
- Optional: A top-down map image for calibrated replay overlays

## Install

From a local checkout:

```bash
npm install
npm run build
```

Run the CLI from source during development:

```bash
node src/cli.ts info path/to/demo.dm_1
```

After building, use the compiled CLI:

```bash
node dist/cli.js info path/to/demo.dm_1
```

If installed globally from npm in the future, the command name is:

```bash
dm1 info path/to/demo.dm_1
```

## Quick Start

Print a summary:

```bash
node src/cli.ts info path/to/Match_mp_crash.dm_1
```

Show map and server metadata:

```bash
node src/cli.ts meta path/to/Match_mp_crash.dm_1
```

Export the recorder's camera path:

```bash
node src/cli.ts path path/to/Match_mp_crash.dm_1 --out camera-path.json
```

Render a simple top-down path video:

```bash
node src/cli.ts render path/to/Match_mp_crash.dm_1 --out path.mp4
```

Render a full tactical replay:

```bash
node src/cli.ts replay path/to/Match_mp_crash.dm_1 --out replay.mp4 --speed 30
```

Render a replay over a calibrated map image:

```bash
node src/cli.ts replay path/to/Match_mp_crash.dm_1 \
  --out replay-map.mp4 \
  --map overview.png \
  --map-extent -1200,-1800,1800,2200
```

## CLI Reference

```text
dm1 info <demo.dm_1>
```

Print a high-level summary: file size, protocol, frame count, snapshot count, duration, average capture FPS, spatial bounds, and clean EOF state.

```text
dm1 meta <demo.dm_1>
```

Decode gamestate metadata and print map name, gametype, config string count, selected server info fields, and the first server commands.

```text
dm1 path <demo.dm_1> [--out file.json]
```

Export the recording client's decoded camera frames as JSON. Without `--out`, JSON is printed to stdout.

```text
dm1 render <demo.dm_1> [--out video.mp4]
```

Render the recording player's path as a top-down mp4.

Useful options:

- `--fps <n>` output frame rate, default `60`
- `--frames <n>` max rendered frames, default `1800`
- `--width <n>` video width, default `1280`
- `--height <n>` video height, default `720`

```text
dm1 replay <demo.dm_1> [--out video.mp4]
```

Decode snapshots and render a full match replay with all players.

Useful options:

- `--speed <n>` playback speed multiplier, for example `30`
- `--seconds <n>` target output length when `--speed` is not set
- `--fps <n>` output frame rate, default `60`
- `--frames <n>` render budget, default `3600` for replay
- `--width <n>` video width, default `1280`
- `--height <n>` video height, default `720`
- `--map <img>` draw over a top-down map image
- `--map-extent <minX,minY,maxX,maxY>` world bounds covered by the map image

```text
dm1 unwrap <file.ff> [--out zone.bin]
```

Inflate a CoD4 FastFile zone and scan printable asset names such as `compass_map_*` and `*.d3dbsp`. This requires your own game files.

```text
dm1 capture <demo.dm_1>
```

Launch CoD4 multiplayer, load the demo, and install capture keybinds.

Useful options:

- `--fps <n>` frame dump rate, default `60`
- `--mod <path>` `fs_game` mod path if auto-detection is not enough
- `--windowed` launch the game windowed

In-game controls generated by the tool:

- `F9` starts `cl_avidemo <fps>` frame dumping
- `F10` stops frame dumping

```text
dm1 encode <screenshots-dir> --out video.mp4
```

Encode dumped numbered frames such as `shot0000.tga`, `shot0001.tga`, and so on.

Useful options:

- `--fps <n>` input/output frame rate, default `60`
- `--ext <ext>` frame extension, default `tga`
- `--crf <n>` x264 quality, lower is better, default `18`

## Example Output

```text
Demo:       Match_mp_crash_YAXs8iBW.dm_1
Size:       15.26 MiB
Protocol:   21
Frames:     228817  (camera path samples)
Snapshots:  36518  (compressed world state)
Duration:   1844.5 s
Avg FPS:    124.05
Bounds min: [-853.2, -1803.6, 46.7]
Bounds max: [1810.9, 2168.0, 580.1]
Clean EOF:  yes
```

## Game-Quality Capture Workflow

For true first-person footage, use the game engine itself. The tool assumes demos live under a standard CoD4 layout such as:

```text
<game-dir>/<fs_game>/demos/<demo-name>.dm_1
```

Start playback and install capture binds:

```bash
node src/cli.ts capture "Mods/fps_promod_277/demos/Match_mp_crash.dm_1" --fps 60
```

Then in-game:

- Press `F9` to start dumping frames.
- Press `F10` to stop dumping frames.

Frames are written to the mod's `screenshots` directory. Encode them with:

```bash
node src/cli.ts encode "Mods/fps_promod_277/screenshots" --out crash.mp4 --fps 60
```

The encoder uses `libx264`, `yuv420p`, and `+faststart` for broadly compatible mp4 output.

## Library Usage

The package also exposes parser utilities from `dist/index.js` after build.

```ts
import { parseDemo, unwrapFastFile, scanStrings } from "cod4-dm1-tools";
import { readFileSync } from "node:fs";

const demo = readFileSync("Match_mp_crash.dm_1");
const result = parseDemo(demo);

console.log(result.stats.frameCount);
console.log(result.stats.cleanEof);
```

Current public exports include:

- `parseDemo`
- `BinaryReader`
- shared demo types
- `unwrapFastFile`
- `scanStrings`

## File Format Notes

At the container layer, every record starts with a one-byte message type:

| Byte | Type | Payload |
| --- | --- | --- |
| `0` | `MSG_SNAPSHOT` | `int seq`, `int size`, `int dummy`, then `size - 4` Huffman-compressed bytes. `seq == -1` marks end-of-demo. |
| `1` | `MSG_FRAME` | `int seq` plus archived frame data: origin, velocity, movement direction, bob cycle, command time, and view angles. |
| `2` | `MSG_PROTOCOL` | `uint32 protocol`, `int legacyEnd`, `uint64 reserved`. |
| `3` | `MSG_RELIABLE` | Not used by the recorded demos this project targets. |

Important details:

- `commandTime` is the client's absolute millisecond clock, not global match time.
- `commandTime` is not globally monotonic because killcams and demo transitions can jump.
- Snapshot payloads use Quake-style adaptive Huffman compression and delta encoded net fields.
- CoD4X protocol variants can send origin components as raw 32-bit floats.

## Development

Install dependencies:

```bash
npm install
```

Build TypeScript:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Run integration tests against a real demo:

```bash
DM1_TEST_DEMO=/path/to/Match_xxx.dm_1 npm test
```

On Windows PowerShell:

```powershell
$env:DM1_TEST_DEMO = "C:\path\to\Match_xxx.dm_1"
npm test
```

Generate net-field tables from the reference C++ source:

```bash
npm run gen:netfields -- /path/to/CoD4-DM1/src/Crypt/NetFields.cpp src/netfieldsData.ts
```

## Test Coverage

The test suite currently covers:

- Little-endian binary reads
- Bit-level reads
- String reads and overflow behavior
- Synthetic `.dm_1` container parsing
- Frame field decoding
- Bounds and duration calculations
- Truncated input handling
- Info-string parsing
- FastFile unwrap behavior
- Capture config generation
- Frame sequence detection
- Optional real-demo parsing, metadata, player bounds, teams, and death events

## Roadmap

- [x] Container parser
- [x] Camera path decode
- [x] JSON path export
- [x] Tactical path renderer
- [x] Huffman gamestate decode
- [x] Net-field player/entity decode
- [x] Full match tactical replay
- [x] Real-time replay pacing and interpolation
- [x] Team colors, labels, alive counts, death markers, and kill feed
- [x] Map image overlay support
- [x] FastFile unwrap/string scan
- [x] Game-quality capture and encode workflow
- [ ] FastFile asset extraction beyond string scanning
- [ ] Automatic compass map extraction
- [ ] Standalone geometry parsing
- [ ] Standalone no-game 3D renderer

For more detail on the 3D rendering scope, see [`docs/PHASE3-3D.md`](docs/PHASE3-3D.md).

## Repository Hygiene

Before publishing a public repository, make sure these are not committed:

- `node_modules/`
- `dist/`, unless intentionally publishing generated output in git
- `out/`
- `frames/`
- `*.dm_1`
- `*.ff`
- `*.iwd`
- captured screenshots or rendered videos
- local `.env` files

The included `.gitignore` is designed to protect these by default.

## Legal And Asset Policy

This project is an independent tool for user-owned demo files. It does not include Call of Duty 4 game assets, maps, models, textures, demos, binaries, or proprietary content.

For features that read FastFiles or launch the game, you must provide your own legally installed copy of Call of Duty 4.

Call of Duty is a trademark of its respective owners. This project is unofficial and unaffiliated with Activision, Infinity Ward, or CoD4X.

## Dependency Licensing Note

The project source is MIT licensed. Video rendering and encoding use [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static), which distributes ffmpeg binaries under `GPL-3.0-or-later`. If your distribution requirements cannot include GPL-covered binaries, replace that dependency with a system-provided ffmpeg flow before redistributing.

## Credits

Demo-format reverse engineering builds on the excellent [`Iswenzz/CoD4-DM1`](https://github.com/Iswenzz/CoD4-DM1) C++ project.

## License

MIT. See [`LICENSE`](LICENSE).
