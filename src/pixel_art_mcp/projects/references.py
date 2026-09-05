import asyncio
import hashlib
import io
import ipaddress
import socket
import warnings
from pathlib import Path
from typing import Any

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

from pixel_art_mcp.config import Settings
from pixel_art_mcp.models import DomainError


def normalize_reference(data: bytes, directory: Path, settings: Settings) -> dict[str, Any]:
    if not data or len(data) > settings.max_upload_bytes:
        raise DomainError("Reference is empty or exceeds the upload size limit", 413)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data), formats=["PNG", "JPEG", "WEBP"]) as source:
                if source.width * source.height > settings.max_image_pixels:
                    raise DomainError("Reference exceeds the decoded pixel limit", 413)
                if getattr(source, "n_frames", 1) != 1:
                    raise DomainError("Upload a still image, not an animated image")
                source.load()
                fmt = source.format
                normalized = ImageOps.exif_transpose(source).convert("RGBA")
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise DomainError("Invalid PNG, JPEG, or WebP reference image") from exc
    directory.mkdir(parents=True, exist_ok=True)
    extension = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[str(fmt)]
    (directory / f"original.{extension}").write_bytes(data)
    normalized.save(directory / "image.png")
    thumbnail = normalized.copy()
    thumbnail.thumbnail((512, 512), Image.Resampling.LANCZOS)
    thumbnail.save(directory / "thumbnail.png")
    return {
        "width": normalized.width,
        "height": normalized.height,
        "sha256": hashlib.sha256(data).hexdigest(),
        "extension": extension,
    }


async def public_target(url: str) -> tuple[httpx.URL, str]:
    try:
        parsed = httpx.URL(url)
        if (
            parsed.scheme != "https"
            or not parsed.host
            or parsed.username
            or parsed.password
            or parsed.port not in (None, 443)
            or parsed.fragment
        ):
            raise ValueError("Expected a public HTTPS URL without credentials")
        answers = await asyncio.get_running_loop().getaddrinfo(
            parsed.host, 443, type=socket.SOCK_STREAM
        )
        addresses = [str(answer[4][0]) for answer in answers]
        if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
            raise ValueError("Private, loopback, link-local, and reserved addresses are disallowed")
        # Pin the connection to an already-validated IP to avoid DNS rebinding.
        return parsed.copy_with(host=addresses[0]), parsed.host
    except (ValueError, httpx.InvalidURL, socket.gaierror) as exc:
        raise DomainError("Reference URL must resolve only to public HTTPS addresses") from exc


async def download_reference(url: str, settings: Settings) -> bytes:
    try:
        async with (
            asyncio.timeout(30),
            httpx.AsyncClient(timeout=15, follow_redirects=False, trust_env=False) as client,
        ):
            for _ in range(4):
                pinned, hostname = await public_target(url)
                async with client.stream(
                    "GET",
                    pinned,
                    # Different hostnames can pin to the same IP. Do not reuse a TLS
                    # connection authenticated for a previous redirect's hostname.
                    headers={"Host": hostname, "Connection": "close"},
                    extensions={"sni_hostname": hostname},
                ) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        if "location" not in response.headers:
                            raise DomainError("Reference download returned an invalid redirect")
                        url = str(httpx.URL(url).join(response.headers["location"]))
                        continue
                    response.raise_for_status()
                    data = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=65536):
                        data.extend(chunk)
                        if len(data) > settings.max_upload_bytes:
                            raise DomainError("Reference exceeds the upload size limit", 413)
                    return bytes(data)
            raise DomainError("Too many reference download redirects")
    except (httpx.HTTPError, TimeoutError):
        # Do not return/log signed URLs or their query parameters.
        raise DomainError("Reference download failed or expired; upload the image again") from None
