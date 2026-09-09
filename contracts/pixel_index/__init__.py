"""Consumer-driven contract checks against a live pixel-index environment.

See docs/contract-testing.md. Kept outside src/pixel_art_mcp and the main uv project:
this app never calls pixel-index at runtime (it only produces zips for manual upload),
so unlike a real API consumer there is no runtime HTTP client here to keep these
checks in sync with — only the CI-time verification in this package.
"""
