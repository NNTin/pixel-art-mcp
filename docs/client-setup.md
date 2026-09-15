# Connect a local client

Start `docker compose up --build -d`, then configure your MCP client with the Streamable HTTP URL:

```text
http://localhost:8000/mcp
```

The client must run on the same machine, or otherwise have a route to this endpoint. No OAuth,
API key, or separate model-provider account is needed. Use a client that can display MCP image
content so the agent can inspect references and generated previews.

For protocol inspection, use the MCP Inspector and select Streamable HTTP with the URL above.
The service accepts the normal initialization and tool-listing flow; it does not require persistent
MCP sessions. If a browser-based inspector supplies an Origin header, that exact origin must be
added to `PIXEL_ALLOWED_ORIGINS` in the container environment. Do not use wildcard origins.

## Upload a local photo

Create a project through the agent, or via `POST /projects` in http://localhost:8000/docs. Use the
project UUID in the upload operation:

```sh
curl -F 'file=@chair.jpg' http://localhost:8000/projects/PROJECT_UUID/references
```

Give the returned reference ID and project ID to the agent. Ask it to call `get_reference_image`
before writing modeling code. Small images can also be uploaded through the base64 MCP tool.

## Suggested first prompt

> Use the Pixel Art Blender MCP server. Inspect the reference image in this project and create
> a native Pixel Agents chair. Discover the chair profile, configure it, then use write_pixel_art
> to draw distinct seat, legs and backrest layers. Render and inspect every view with MCP previews.

Follow up with “Make the backrest taller and change the wood to blue.” The agent should load the
project's current definition with get_pixel_art, edit named poses/palette with edit_pixel_art, wait, and render
the revised scene. It should not claim it modified the model before the job succeeds.

## Troubleshooting

- After upgrading, refresh cached tools. Capabilities must report `pixel_authoring_required: true`
  and `authoring_contract_version: 1`; the tools include `write_pixel_art` and `get_asset_preview`.
  Targeted editing/delivery also expose `edit_pixel_art` and `get_artifact_chunk`.
- Check `/health/ready` and `docker compose logs pixel-art-mcp` if modeling is unavailable.
- Inspect `get_job` for script tracebacks and rendering failures; upload/prompt errors do not need
  a service restart.
- For a revision conflict, fetch the latest project, inspect it, then adapt and resubmit the script.
- Artifact links point to the local service. Set `PIXEL_BASE_URL` if your local client uses a
  different address, and separately configure allowed hosts if changing the deployment hostname.
  This must be the recipient's reachable URL, not a Docker-internal hostname. Small ZIP/.blend
  artifacts now include embedded MCP bytes; any artifact can also be read using
  `get_artifact_chunk` without HTTP. Saving/installing still requires your client's attachment
  integration; tool-only agents cannot write to the user's filesystem by themselves.
- Docker data persists in the named volume. Stop the service before backing it up.
- ChatGPT's website needs a remote connection path; it cannot directly use your computer's
  `localhost`. This release deliberately targets local MCP clients.

Future ChatGPT file handoff uses the official
[file-input metadata contract](https://developers.openai.com/plugins/reference#define-file-inputs).
The compatibility field alone does not make the service remotely reachable.
