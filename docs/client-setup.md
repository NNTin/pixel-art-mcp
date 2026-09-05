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
> a stylized 3D chair using execute_blender_python. Name the seat, legs, and backrest. Render a
> preview and inspect it before exporting transparent 64x64 sprites at 0, 45, and 90 degrees.

Follow up with “Make the backrest taller and change the wood to blue.” The agent should load the
project's current revision, modify named objects using Python, wait for completion, and render
the revised scene. It should not claim it modified the model before the job succeeds.

## Troubleshooting

- Check `/health/ready` and `docker compose logs pixel-art-mcp` if modeling is unavailable.
- Inspect `get_job` for script tracebacks and rendering failures; upload/prompt errors do not need
  a service restart.
- For a revision conflict, fetch the latest project, inspect it, then adapt and resubmit the script.
- Artifact links point to the local service. Set `PIXEL_BASE_URL` if your local client uses a
  different address, and separately configure allowed hosts if changing the deployment hostname.
- Docker data persists in the named volume. Stop the service before backing it up.
- ChatGPT's website needs a remote connection path; it cannot directly use your computer's
  `localhost`. This release deliberately targets local MCP clients.

Future ChatGPT file handoff uses the official
[file-input metadata contract](https://developers.openai.com/plugins/reference#define-file-inputs).
The compatibility field alone does not make the service remotely reachable.
