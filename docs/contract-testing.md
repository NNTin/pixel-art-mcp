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
- **`openapi-query-shape`** — diffs `POST /api/v1/assets`'s documented query constraints
  (the `assetKind` enum, the `category` enum, the `name` length cap) against this repo's
  own Pydantic models (`src/pixel_art_mcp/models.py`). This is how a real mismatch was
  caught while building this feature: pixel-index's `name` cap is 60 characters,
  `PixelAgentsOptions.name` (and friends) allowed 120.
- **`manifest-schema-furniture`** / **`manifest-schema-pet`** — build one manifest the
  *same way the real exporters do* (`imaging/pixel_agents.py`, `imaging/pet.py`, with small
  synthetic fixture inputs — not a hand-duplicated JSON blob that could quietly drift from
  what the code actually generates) and validate it against the schema fetched live from
  `GET /api/v1/assets/schema/:kind` on that same environment. Character has no manifest to
  check — it's a manifest-less PNG, see
  [the contract doc](https://github.com/pixel-agents-hq/index/blob/main/docs/custom-asset-zip-contract.md).
- **`assets-list`** — a real `GET /api/v1/assets?limit=1` call, checking returned
  `assetKind` values are within the expected set.

A check whose route or schema doesn't exist yet on an environment (production, as of this
writing, predates pixel-agents-hq/index#108 entirely — no `/api/v1/assets`, no schema
endpoint) is reported `skipped` with a clear reason, not `fail` — that's an expected gap
while production hasn't deployed that commit yet, not a regression to chase.

## What this deliberately does not check

`POST /api/v1/assets` requires authentication — a Bearer session or an `X-Api-Key` +
`discordUserId` (see `services/api/src/assets/submit.ts` in pixel-agents-hq/index) — that
this project has no credentials for. **No authenticated upload is attempted anywhere
here.** A pass means "the zip shapes this repo generates should still be accepted by this
environment's decode logic," inferred from the schema and query constraints — not "a real
upload to this environment would succeed right now." Issue #8 itself leaves a genuine
upload-based check (with cleanup, or a pixel-index dry-run mode) as an open question for a
future iteration, not assumed here.

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
