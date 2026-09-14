# MCP-only agent evaluation

Deterministic tests verify the tool contract, not whether a model can design recognizable art.
Run a fresh agent with only this server's tools, initialization instructions and live schemas.
Do not give it repository examples, Python helpers, a terminal, or an HTTP client. Use a
vision-capable model/client that forwards MCP image content. Text-only clients can use
`inspect_sprite`, but that is not equivalent to visual review.

## Tasks

1. A floor-standing 3x4 cat tree: stable base, connected sisal posts, three carpeted platforms,
   cubby with a visible entrance in appropriate views, dangling toy, four directions.
2. A 2x1 office printer: paper tray, contrasting paper, control panel, four directions.
3. A 16x32 wall thermometer: clear glass channel, bulb and ticks, cold/room/hot variants.

For each task, require the installable package and a preview through the client's attachment
integration. Filesystem writes and Discord delivery are client capabilities, not model tools.
In Animator, `deliver_pixel_agents_assets` provides the furniture delivery step; embedded
`get_artifact` resources are also preserved and staged by its adapter.

## Record

- Initialization instructions, live tool-schema version/content, model and provider settings.
- Tool-call count, argument sizes, validation retries, finish reasons, failed jobs, lost features.
- Whether numeric commands and incremental writes are used without coaching after errors.
- Per-view native sizes, occupied footprint, alpha/palette checks, opaque and color components.
- Whether actual preview images reached the model, rather than only JSON metadata.
- A human review at native size and integer magnification: recognizable object, required details,
  connected structural elements, meaningful directional views, and no texture obscuring features.
- Package integrity and real delivered attachments. Internal download URLs alone do not pass.

Connectivity is evidence, not a universal art rule: deliberate detached effects can be valid.
Technical `checks_passed` alone does not satisfy the visual criteria. Save artifacts and compare
several independent runs using the same task prompts. Do not count a scripted fixture as an
unassisted model success.

## Automated regression

`tests/unit/test_drawing.py` covers exact helper pixels, row diagnostics, strict coordinates,
repetition bounds/budgets and custom tile sizing. `tests/e2e/test_custom_drawing.py` builds the
cat tree through MCP in five incremental mutations, checks rejected-edit rollback, all-view
connectivity, palette/alpha preservation, inline preview bytes and the installable ZIP metadata.
`tests/e2e/test_cold_client.py` covers profile-guided furniture, characters and pets without
reading repository examples. None of these tests calls a real model.
