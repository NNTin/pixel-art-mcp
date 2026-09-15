# Consumer-driven contract testing against pixel-index

pixel-art-mcp exports zips ([pixel-agents furniture](tools.md#pixel-agents-furniture-package),
[character](tools.md#pixel-agents-character-package), and
[pet](tools.md#pixel-agents-pet-package) packages) meant to be uploaded to a
[pixel-index](https://github.com/pixel-agents-hq/index) instance's `POST /api/v1/assets`. Neither
project can gate its own releases on the other's needs alone — pixel-index has other
consumers, and pixel-art-mcp has no way to make pixel-index hold still. This is the
consumer side of closing that gap
([NNTin/pixel-art-mcp#8](https://github.com/NNTin/pixel-art-mcp/issues/8)), modeled on
[pixel-agents-cogs](https://github.com/pixel-agents-hq/pixel-agents-cogs)' own
consumer-driven contract testing against pixel-index's read API
(`contracts/pixel_index/`, `docs/contract-testing.md`).

## The model: live, not pinned

**No schema file is vendored into this repo, and no commit is pinned.** Pinning would mean
manually re-syncing every time pixel-index's contract changes; instead,
[`contracts/pixel_index/checks.py`](../contracts/pixel_index/checks.py) fetches each
manifest schema straight from the environment being checked, via pixel-index's own
`GET /api/v1/assets/schema/:kind` — a live, unauthenticated discovery endpoint added in
[pixel-agents-hq/index#108](https://github.com/pixel-agents-hq/index/pull/108) directly in
response to this check having no such endpoint to use at first (it originally reached across
to `raw.githubusercontent.com` using the commit `GET /` self-reports; that repo-crossing
step is gone now that pixel-index serves its own schemas). A pass is always a claim about
what's live *right now*, and there is nothing to remember to update when pixel-index ships
a change.

[`contracts/pixel_index/verify.py`](../contracts/pixel_index/verify.py) runs each check in
[`checks.py`](../contracts/pixel_index/checks.py) against a given `--base-url` and writes a
structured result. Run it directly:

```sh
pip install -r contracts/pixel_index/requirements.txt
PYTHONPATH=src python -m contracts.pixel_index.verify --base-url https://pixel-index-api-staging.nntin.xyz
```

The checks:

- **`root`** — `GET /`, mainly to surface the commit an environment reports for the pass
  detail on the other checks; nothing downstream depends on it.
- **`openapi-query-shape`** — confirms `POST /api/v1/assets` no longer declares
  `assetKind`/`category`/`name` as query params (#105 follow-up: the server detects the
  kind and reads name/category straight from the zip's own manifest instead). If
  pixel-index ever brings one of these back, this repo's zips would silently stop
  supplying it and every upload would start failing with no local signal.
- **`manifest-schema-furniture`** / **`manifest-schema-character`** / **`manifest-schema-pet`**
  — build one manifest the *same way the real exporters do* (`imaging/pixel_agents.py`,
  `imaging/character.py`, `imaging/pet.py`, with small synthetic fixture inputs — not a
  hand-duplicated JSON blob that could quietly drift from what the code actually
  generates) and validate it against the schema fetched live from
  `GET /api/v1/assets/schema/:kind` on that same environment.
- **`assets-list`** — a real `GET /api/v1/assets?limit=1` call, checking returned
  `assetKind` values are within the expected set.

A check whose route or schema doesn't exist yet on an environment (production, as of this
writing, predates pixel-agents-hq/index#108 entirely — no `/api/v1/assets`, no schema
endpoint) is reported `skipped` with a clear reason, not `fail` — that's an expected gap
while production hasn't deployed that commit yet, not a regression to chase.

## What this deliberately does not check

`POST /api/v1/assets` requires authentication — a Bearer session or an `X-Api-Key` +
`discordUserId` (see `services/api/src/assets/submit.ts` in pixel-agents-hq/index) — that
this project has no credentials for on any *deployed* environment. **No authenticated
upload to staging or production is attempted anywhere here.** A pass means "the zip
shapes this repo generates should still be accepted by this environment's decode
logic," inferred from the schema and query constraints — not "a real upload to this
environment would succeed right now."

A genuine upload-based check now exists, just not against a deployed environment —
see [Publish check: a real upload, against a real pixel-index this repo stands up
itself](#publish-check-a-real-upload-against-a-real-pixel-index-this-repo-stands-up-itself)
below.

## Publish check: a real upload, against a real pixel-index this repo stands up itself

[`.github/workflows/pixel-index-publish-check.yml`](../.github/workflows/pixel-index-publish-check.yml)
is issue #8's real-upload follow-up, and deliberately a separate workflow rather than a
job added to this one. Everything above asks a *deployed* pixel-index what it currently
accepts, live and unpinned — that's the whole point of this file's "live, not pinned"
model, and there is no deployed environment this repo controls well enough to safely
upload throwaway test assets to. So instead, this check vendors pixel-index itself
(`vendor/pixel-index`, a git submodule pointed at the same
[pixel-agents-hq/index](https://github.com/pixel-agents-hq/index) remote), stands up a
real instance from it (Postgres + renderer + API, reusing pixel-index's own
`services/api/e2e/` test fixture — unguilded, so any inserted user may submit with no
Discord OAuth round trip), and actually POSTs every example's real installable package
zip (`scripts/generate_examples.py`'s output) to it via
[`scripts/publish_examples_to_pixel_index.py`](../scripts/publish_examples_to_pixel_index.py).
A pass here means pixel-index's real decode/ingest logic accepted the exact zip this
repo produced, not just that it matches a schema.

This is the one place in the repo pixel-index's code is vendored rather than asked live
— see the workflow file's own header comment for why that's still consistent with this
file's "no schema file is vendored" rule above: that rule is about not *pinning a
contract* to avoid re-syncing; running pixel-index's actual server to prove a real
upload works is a different need entirely, one no live HTTP check can satisfy.

That check also found, and now documents and handles, one real structural mismatch:
pixel-art-mcp's multi-clip furniture examples (`rain-barrel`, `thermometer`) package
every clip's own `manifest.json` into one zip — intentional, matching what a native
Pixel Agents install expects — but pixel-index accepts at most one `manifest.json` per
upload. [`scripts/pixel_index_packaging.py`](../scripts/pixel_index_packaging.py)'s
`split_multi_clip_zip()` splits such a zip back into one zip per clip (see its module
docstring for the full reasoning); `scripts/publish_examples_to_pixel_index.py` uses it
to publish each clip as its own separate pixel-index catalog entry, and
`scripts/generate_examples.py` uses the same function to also write each clip's zip
into the example gallery with its own download link — the bundled `pixel-agents.zip`
a multi-clip example's card still links to is correct for a native Pixel Agents
install, but is **not** directly uploadable to pixel-index; the per-clip zips are
what a person publishing one of these to pixel-index by hand actually wants. That
split is a real, deliberate product-shape decision, not a bug being silently papered
over.

## When it runs

[`.github/workflows/contract-checks.yml`](../.github/workflows/contract-checks.yml) runs the
check on a schedule (every 8 hours), on `push` to `develop`, on `workflow_dispatch`, and on
any PR touching `contracts/pixel_index/**` or the source files the checks build fixtures
from. It runs as a matrix over known environments:

| Environment | Base URL |
|---|---|
| production | `https://pixel-index-api.nntin.xyz` |
| staging | `https://pixel-index-api-staging.nntin.xyz` |

Add a new environment by adding a row to the `matrix.include` list under the
`verify-contract` job — no other changes needed.

On the default branch, results are also published to a GitHub Pages status site (JSON API
+ a plain HTML page) via `actions/upload-pages-artifact` + `actions/deploy-pages`, generated
by [`contracts/pixel_index/generate_status_site.py`](../contracts/pixel_index/generate_status_site.py)
(adapted from pixel-agents-cogs' script of the same name). **GitHub Pages must be enabled
for this repository** (Settings → Pages → Source: GitHub Actions) for the deploy step to
succeed — a one-time setup step for a repo admin, not something this workflow can do for
itself.

This is also where the [example asset gallery](game-assets.md#reproduce-examples-and-webview-checks)
(every example in `examples/asset-specs.json`, generated through the real MCP rendering
pipeline — [NNTin/pixel-art-mcp#15](https://github.com/NNTin/pixel-art-mcp/issues/15)) gets
published, under `examples/` alongside the contract dashboard at the site root. Both are built
and deployed together in this one workflow because a repository has exactly one GitHub Pages
site: two workflows independently calling `actions/deploy-pages` would each overwrite the
other's content instead of coexisting. The `generate-examples-gallery` job runs the same
Docker Compose service the `docker` CI job uses, drives it through
`scripts/generate_examples.py` with no `--only` filter (every example, not a subset), and
`build-status-site` folds its output in before generating the dashboard HTML — which links
to it when present.

### How to read a result

- **Staging passes** → the zips this repo generates match what's actually deployed there.
- **Staging fails** → either pixel-index's contract changed in a way this repo doesn't
  handle yet, or this repo's own understanding needs an update — check which check failed
  and its detail for which side needs to change.
- **A check is `skipped`** → the environment doesn't have that route/schema yet (expected
  for production today); not a failure.

## Actual webview rendering checks

The game asset workflow also has a [development browser harness](game-assets.md#reproduce-examples-and-webview-checks).
It imports the consumer's own decoders, catalog, layout, activation logic, sprite selectors, and
canvas renderer from a read-only checkout. Its local report identifies the tested commit and
records the unchanged checkout status. This complements the live API schema checks: PNG dimensions
and a valid manifest alone cannot establish correct placement, animation, or visual readability.
