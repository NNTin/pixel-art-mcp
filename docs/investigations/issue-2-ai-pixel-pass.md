# Issue 2: AI pixel-pass investigation

Date: 2026-09-07

Issue: [AI generate lower res instead of downscaling](https://github.com/NNTin/pixel-art-mcp/issues/2)

## Decision

**Edit the downscaled sprite rather than asking an image model to redraw each frame on a clean
canvas.** Use the 16x32 downscale as the edit target and the supersampled render as a second,
read-only reference for details that disappeared during reduction.

The downscale is not a sufficient reference by itself, but it is the only input that already fixes
all of the production invariants: canvas size, camera, pivot, silhouette, occupancy, orientation,
frame order, and motion. In the representative 32-frame rain-barrel test, the clean-canvas route
changed 35.66% of supposedly static body pixels between animation frames. Editing the downscaled
sheet reduced that to 8.79%. The unmodified deterministic export changed 0.28%.

Neither image-model route is ready to insert directly into the exporter. Even when explicitly
prompted for exact logical dimensions, a fixed palette, hard alpha, and invariant body pixels, the
model returned large RGBA illustrations with many colors and soft/chroma edges. Exact resizing,
alpha cleanup, palette reduction, cell validation, and temporal validation remain mandatory.

## Text-only implementation follow-up

The implemented deterministic path addresses the specific mixed-color failure without requiring an
image model. `downscale_mode="crisp"` fits the shared palette from supersampled source colors before
mapping BOX-downscaled pixels. The legacy `"average"` mode fits its palette after downscaling. An
`inspect_sprite` MCP tool exposes the exact result as text so an agent with completion and MCP tools,
but no vision, can inspect or compare selected state/direction/frame cells.

The rain-barrel scene was rerendered through the source MCP JSON-RPC endpoint in crisp mode, then
`inspect_sprite` compared `full / 0° / frame 21` with the earlier average export. Both results kept
the same 291 occupied pixels, `[1, 4, 14, 25]` bounds, and alpha mask. The textual evidence showed:

- average mode represented the relevant light colors as `#a6ddc4` (light green) and `#b5bd98`
  (medium green), visually merging water and the pale gauge case;
- crisp mode retained `#7fcec4` (medium cyan) and `#ddd4a4` (light yellow), giving the gauge fill and
  case separate source-derived color families;
- crisp mode reduced same-color connected components from 106 to 98 and singleton components from
  68 to 45 while leaving occupancy unchanged.

The tool also returned the full 16x32 palette-token grid, palette bounds, component counts, and
longest runs. A text-only agent can locate the gauge as adjacent vertical yellow/cyan runs, modify a
named Blender object or its material, rerender, and compare the new job through the same tool. The
real tool response and crisp export are in the git-ignored paths
`tmp/issue-2/mcp-inspect-comparison.json` and `tmp/rain-barrel-crisp/`.

## Setup and generated examples

All examples were generated without Docker and without registering the MCP server. The application
was constructed from `pixel_art_mcp.app.create_app`, then exercised through its in-process
Streamable HTTP JSON-RPC endpoint. This called the source implementations of:

1. `get_capabilities`
2. `create_project`
3. `execute_blender_python`
4. `wait_for_job`
5. `render_sprites`
6. `get_artifact`

The Blender scripts came directly from `examples/`. `modify_chair.py` was applied as a second chair
revision. Output ZIPs were downloaded and extracted to the git-ignored directories below:

| Example | Output | Render time |
| --- | --- | ---: |
| Chair | `tmp/chair/base/` | 1.05 s |
| Modified chair | `tmp/chair/modified/` | 1.05 s |
| Bobbing cube, 4 directions x 8 frames | `tmp/bobbing-cube/` | 2.06 s |
| Oil lamp, 4 directions x 8 frames + off poses | `tmp/oil-lamp/` | 2.10 s |
| Rain barrel, 3 states x 4 directions x (8 frames + off pose) | `tmp/rain-barrel/` | 17.39 s |

These timings are local wall-clock observations, not general performance claims. The run used the
pinned Blender 4.5.13 release, Python 3.12.12, eight Blender threads, and commit `8e8f237`. The model
and render options are the documented examples; chair used a 1x2 canvas and the cube used four
cardinal views.

The rain-barrel output is the useful stress case:

- 96 on-state PNGs plus 12 off-state PNGs
- 16x32 pixels per sprite
- a combined 128x384 sheet
- 55,296 final sprite pixels across on and off poses
- 4x supersampled reference frames, or 884,736 source pixels
- one camera and one 16-color palette across all three states

The sprite sheet is therefore small in storage and pixel count, but semantically large: every
additional cell is another opportunity for the AI pass to change static pixels, framing, or object
identity.

## Benchmark

The full-state rain-barrel frame at direction 0/frame 21 and its 32-frame sheet were tested in two
ways:

- **Edit downscale:** the existing 16x32 result (or 128x128 full-state sheet) was the edit target.
- **Clean canvas:** the 4x supersampled Blender render (or 512x512 full-state reference sheet) was
  reference material for a new pixel-art drawing.

Both prompts required a strict 16-color palette, transparent 16x32 cells, the original 8x4 layout,
and pixel-identical barrel bodies within an animation row. A removable chroma background was used
because the image tool did not expose native transparency. The outputs were normalized to the
required dimensions, hard alpha, and 15 opaque colors plus transparency before comparison.

The two single-frame calls took about 25 seconds each. The 32-frame sheet calls took about 52
seconds for edit-downscale and 58 seconds for clean-canvas. The model returned 887x1774 pixels for
single sprites and 1254x1254 pixels for sheets, rather than the requested final dimensions.

### Measured results

| Metric | Existing downscale | Edit downscale | Clean canvas |
| --- | ---: | ---: | ---: |
| Single-frame occupied pixels (of 512) | 291 | 351 | 394 |
| Single-frame occupancy change | baseline | +20.6% | +35.4% |
| Sheet occupied pixels (of 16,384) | 9,352 | 8,932 | 7,247 |
| Sheet occupancy change | baseline | -4.5% | -22.5% |
| Mean changed body pixels vs frame 1 | 0.28% | 8.79% | 35.66% |
| Worst changed body pixels vs frame 1 | 1.25% | 14.69% | 52.81% |

“Body pixels” are the bottom 20 rows of each 16x32 cell; the top 12 rows containing the intended
water/rain animation are excluded. Pixel equality is evaluated after applying one shared reduced
palette to each candidate. This deliberately strict metric detects shimmer in regions that should
not animate.

The generated evidence and measurement script remain in `tmp/issue-2/`:

- `single-comparison.png`
- `sheet-comparison.png`
- `metrics.json`
- the original model outputs, alpha-cleaned intermediates, and exact-size normalized PNGs

### Visual findings

**Edit downscale** kept the 32-cell layout, approximate source occupancy, row identity, and feature
locations. It made the front gauge and faucet clearer at the model's native output resolution. It
still invented wood/gauge detail independently per frame, and the improvement partly collapsed
when normalized to 16x32.

**Clean canvas** made a more deliberate and attractive isolated pixel-art design. It also changed
the camera interpretation and scale. In the full sheet it drew smaller sprites, varied their bounds,
and independently redesigned static body pixels. That is acceptable concept art but unsafe sprite
animation: the body visibly shimmers even though only water and rain should move.

Both approaches violated explicit constraints. Before normalization, the alpha-cleaned single
outputs contained 37k-44k opaque RGB colors; sheets contained 140k-192k. The generated backgrounds
also needed chroma cleanup and left partially transparent edge pixels. “Pixel art” in an image-model
prompt describes an appearance, not an exact indexed-pixel data contract.

## Recommended design

Add a refinement stage after `pixelate` and before `pack_sprites`, but make it an **optional,
validated edit pass**, not a replacement renderer:

1. Render and downscale exactly as today.
2. Give the model both inputs for each batch:
   - edit target: the final-size downscaled cells;
   - supporting reference: their supersampled cells.
3. Keep stable content out of repeated generation. Refine one canonical body per
   state/direction, then request only explicit animated-region patches for other frames.
4. Prefer a structured response (indexed pixels or pixel-coordinate patches) over an unconstrained
   large raster. If a raster model is used, require a deterministic normalization step.
5. Reuse the existing shared palette rather than allowing each call or state to invent colors.
6. Reject, do not silently publish, a refined batch unless it passes:
   - exact RGBA dimensions and cell count;
   - binary alpha and canonical transparent RGB;
   - allowed shared palette only;
   - unchanged pivot and bounded occupancy/silhouette delta;
   - unchanged protected body pixels across animation frames;
   - expected state/direction/frame ordering.
7. Package both original and refined previews so a client can approve or fall back to the
   deterministic sprites.

Batch by state or direction, not one unrelated call per frame. The experiment shows that a 32-cell
sheet is manageable as an image input, but the model cannot be trusted to maintain temporal
invariants on its own. A canonical-body-plus-patches representation makes the number of frames much
less important and prevents static flicker by construction.

## Suggested acceptance benchmark

Use the rain barrel as the initial regression fixture and compare against the current deterministic
export. A viable refinement backend should meet all hard format checks and:

- change **0% protected body pixels** between frames in the same state/direction;
- keep per-cell opaque occupancy within 10% of the deterministic target unless explicitly allowed;
- preserve all 108 frame keys, pivots, and ordering;
- make the gauge and faucet recognizable at 1x scale in all directions where each is visible;
- improve a blind side-by-side human preference check without introducing animation shimmer.

The first implementation should stay backend-agnostic: define the refinement request/response and
validator boundary before selecting a hosted image model. That keeps the deterministic path fast,
local, and usable when no AI image service is configured.
