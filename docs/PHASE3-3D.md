# Phase 3 — 3D rendering (scoping)

This documents what a true 3D replay would require, why it is large, and a
phased plan. It is research/scoping, not yet implemented.

## The problem

A `.dm_1` only contains game *state* (decoded in Phases 0–2: every player's
position/angles per snapshot). To draw a 3D scene we additionally need the
map geometry, models, and materials — none of which are in the demo. They live
in Call of Duty 4's **FastFiles** (`.ff`), which the user owns via their game
install. This is an asset-pipeline problem, separate in kind from the demo
protocol work.

## Asset pipeline (IW3 / CoD4)

1. **FastFile container** — `.ff` begins with a 12-byte header (`IWffu100…`,
   where `u` = zlib). The remainder is a single **zlib-compressed zone blob**.
   Decompress with `zlib.inflate`. (Tools: go-ff, iw_ff_extract, CoD-FF-Tools.)
2. **Zone** — a flat memory image with a pointer-fixup table; assets are laid
   out as C structs with `-1` placeholder pointers resolved at load. Parsing
   requires walking the asset list in the exact struct layout for the IW3
   build. This is the hard, version-sensitive part.
3. **Assets we'd need**
   - `GfxWorld` — renderable map surfaces (vertices, indices, materials) and
     the static model placements.
   - `XModel` — player/prop meshes + LODs + skeletons.
   - `Material` / `GfxImage` — shaders and textures (`.iwi`, DXT-compressed).
   - `clipMap` — collision (optional, for occlusion/raycasts).

## Renderer

- Headless GL/Vulkan (e.g. WebGL via `headless-gl`, or a native binding) or a
  software rasterizer.
- Load `GfxWorld` surfaces + textures; place `XModel`s for players at the
  decoded positions/angles each frame; add a follow/orbit/free camera.
- Pipe frames to ffmpeg exactly as the 2D renderer does today.

## Why it's large

The zone struct layout is extensive and build-specific; getting `GfxWorld`
vertex/material parsing bit-exact is the bulk of the effort, comparable to the
entire Phase 2 net-field port — plus a real 3D renderer and texture decoding.
Realistically multiple weeks.

## Suggested phasing

- **3a — FastFile unwrap [DONE]**: `.ff` → inflated zone bytes + asset-name
  scan. Implemented in `src/fastfile.ts` (`unwrapFastFile`, `scanStrings`) and
  the `unwrap` CLI command. Verified on `zone/english/mp_crash.ff` (35 MiB →
  60.2 MiB zone; surfaces `compass_map_mp_crash`, `maps/mp/mp_crash.d3dbsp`).
- **3b — Geometry only**: parse `GfxWorld` surfaces; render untextured map
  triangles + player boxes in 3D → mp4. Proves the pipeline.
- **3c — Textures & models**: `.iwi`/DXT decode, `XModel` meshes.
- **3d — Polish**: cameras, lighting, killcam-style follow.

## Pragmatic alternative (shipped)

The **map overlay** (`replay --map <img> --map-extent …`) already gives a
"real replay" feel by drawing players over a top-down map image — for which
CoD4's own `compass_map_*` overview images (also inside the FastFiles, but a
single small image rather than full geometry) are ideal. This captures most of
the value of 3D for a tactical top-down replay at a fraction of the cost.

## References

- CoD4 FastFile format — https://wiki.zeroy.com/index.php?title=Call_of_Duty_4%3A_FastFile_Format
- go-ff (FastFile extractor) — https://github.com/twonull/go-ff
- iw_ff_extract — https://github.com/BraXi/iw_ff_extract
- CoD-FF-Tools — https://github.com/primetime43/CoD-FF-Tools
