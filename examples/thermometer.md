# Thermometer

A wall-mounted glass thermometer drawn at 16x32 native pixels with eight colors. The front has
a two-pixel red column, a four-pixel-wide bulb and seven scale marks. Cold, room and hot are three
static furniture variants, not a live temperature sensor. Side/back views show the casing.

`thermometer.json` is the complete `write_pixel_art.definition` payload, with no Python, imports,
file paths or project IDs. Its target specification is under `thermometer` in `asset-specs.json`.
The `chair` preset supplies a 16x32 canvas; explicit `category: wall` and `placement: wall` prevent
chair metadata. The server derives all four native view sizes.

The drawing was authored and visually refined using only the live Pixel Art MCP tools. Connected
agents did not need these files: they received the schema and profile inline, wrote pixel rows,
retrieved source, revised it, and inspected the result through MCP. These files archive that
finished input for developer replay; they are not an extra capability given to a cold client.

## Reproduce

```sh
uv run python scripts/generate_examples.py --base-url http://localhost:8000 --output tmp --only thermometer
node scripts/check_webview.mjs --consumer ../pixel-index/vendor/pixel-agents --assets tmp --only thermometer --output tmp/thermometer/webview
```

The development script reads this fixture, sends it through `write_pixel_art`, waits, renders,
inspects and downloads the result. Unlike an MCP-only agent, that script has a filesystem and
HTTP client for local artifact delivery. It never edits the returned sprites.
