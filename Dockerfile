FROM ghcr.io/astral-sh/uv:0.9.18 AS uv
FROM python:3.12.12-slim-bookworm

ARG BLENDER_VERSION=4.5.13
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    PIXEL_DATA_DIR=/data \
    PIXEL_LISTEN_HOST=0.0.0.0 \
    PIXEL_BLENDER_BINARY=/opt/blender/blender \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config \
    PATH=/app/.venv/bin:$PATH

RUN test "$(dpkg --print-architecture)" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl xz-utils libglib2.0-0 libgl1 libegl1 libgomp1 \
       libx11-6 libxi6 libxrender1 libxfixes3 libxxf86vm1 libxkbcommon0 libsm6 libice6 \
       libxext6 \
    && apt-get clean

# Verify the pinned release archive against Blender's release checksum list.
RUN curl --fail --show-error --location --retry 3 \
      "https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
      --output /tmp/blender.tar.xz \
    && curl --fail --show-error --location --retry 3 \
      "https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}.sha256" \
      --output /tmp/blender.sha256 \
    && python -c 'import hashlib,pathlib,sys; name="blender-"+sys.argv[1]+"-linux-x64.tar.xz"; rows=[line.split() for line in pathlib.Path("/tmp/blender.sha256").read_text().splitlines()]; hashes=[r[0] for r in rows if len(r)==2 and r[1].lstrip("*")==name]; assert len(hashes)==1, "Missing archive checksum"; actual=hashlib.file_digest(open("/tmp/blender.tar.xz","rb"),"sha256").hexdigest(); assert actual==hashes[0], "Blender checksum mismatch"' "${BLENDER_VERSION}" \
    && mkdir /opt/blender \
    && tar -xJf /tmp/blender.tar.xz --strip-components=1 -C /opt/blender \
    && python -c 'from pathlib import Path; Path("/tmp/blender.tar.xz").unlink(); Path("/tmp/blender.sha256").unlink()' \
    && /opt/blender/blender --background --version

COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
COPY examples ./examples
COPY vendor/pixel-art-fixer/python ./vendor/pixel-art-fixer/python
RUN uv sync --frozen --no-dev --no-editable \
    && useradd --uid 10001 --create-home app \
    && mkdir /data \
    && chown app:app /data

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3)"]
CMD ["pixel-art-mcp"]
