import base64
import io
import socket
from unittest.mock import AsyncMock

import httpx
import pytest
from PIL import Image

from pixel_art_mcp.models import DomainError
from pixel_art_mcp.projects.references import download_reference, public_target


async def test_upload_normalizes_and_returns_image(service, png):
    project = service.create_project("Chair")
    ref = await service.add_reference_input(
        str(project.id), base64.b64encode(png).decode(), None, "../photo.png"
    )
    assert ref.filename == "photo.png"
    assert (ref.width, ref.height) == (24, 32)
    assert service.get_project(str(project.id)).references == [ref]
    with Image.open(service.artifact_path(str(ref.image_artifact_id))) as im:
        assert im.mode == "RGBA"
    assert service.artifact_path(str(ref.original_artifact_id)).read_bytes() == png


async def test_invalid_images_and_size_limits_leave_no_records(service, png):
    project_id = str(service.create_project("Chair").id)
    for data in (b"not an image", b"", b"<svg></svg>"):
        with pytest.raises(DomainError):
            await service.add_reference(project_id, data, "fake.png")
    service.settings.max_upload_bytes = 5
    with pytest.raises(DomainError, match="size limit"):
        await service.add_reference(project_id, png, "large.png")
    service.settings.max_upload_bytes = 1024 * 1024
    service.settings.max_image_pixels = 10
    with pytest.raises(DomainError, match="pixel limit"):
        await service.add_reference(project_id, png, "wide.png")
    assert service.get_project(project_id).references == []
    assert service.store.records(project_id, "artifact") == []


async def test_exif_orientation_and_animated_rejection(service):
    project_id = str(service.create_project("Photo").id)
    stream = io.BytesIO()
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (20, 10)).save(stream, "JPEG", exif=exif)
    ref = await service.add_reference(project_id, stream.getvalue(), "photo.jpg")
    assert (ref.width, ref.height) == (10, 20)
    animated = io.BytesIO()
    Image.new("RGB", (10, 10), "red").save(
        animated, "PNG", save_all=True, append_images=[Image.new("RGB", (10, 10), "blue")]
    )
    with pytest.raises(DomainError, match="still image"):
        await service.add_reference(project_id, animated.getvalue(), "animation.png")


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "http://example.com/a.png", "https://user:pass@example.com/a.png"]
)
async def test_reference_url_scheme_and_credentials(url):
    with pytest.raises(DomainError):
        await public_target(url)


async def test_reference_dns_is_validated_and_pinned(monkeypatch):
    import asyncio

    loop = asyncio.get_running_loop()
    lookup = AsyncMock(
        return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
    )
    monkeypatch.setattr(loop, "getaddrinfo", lookup)
    with pytest.raises(DomainError):
        await public_target("https://example.com/photo.png")
    lookup.return_value = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
    url, hostname = await public_target("https://example.com/photo.png?token=test")
    assert url.host == "93.184.216.34"
    assert hostname == "example.com"
    assert url.path == "/photo.png"


async def test_base64_requires_one_source_and_rejects_bad_encoding(service):
    project_id = str(service.create_project("Photo").id)
    with pytest.raises(DomainError, match="exactly one"):
        await service.add_reference_input(project_id, None, None, "a.png")
    with pytest.raises(DomainError, match="base64"):
        await service.add_reference_input(project_id, "not base64!", None, "a.png")


async def test_download_validates_redirects_and_preserves_tls_hostname(monkeypatch, settings, png):
    import pixel_art_mcp.projects.references as references

    visited = []

    async def target(url):
        parsed = httpx.URL(url)
        visited.append(parsed.host)
        if parsed.host == "private.example":
            raise DomainError("Private address")
        return parsed.copy_with(host="93.184.216.34"), parsed.host

    def respond(request):
        assert request.url.host == "93.184.216.34"
        assert request.headers["Host"] == request.extensions["sni_hostname"]
        assert request.headers["Connection"] == "close"
        if request.url.path == "/redirect":
            return httpx.Response(302, headers={"Location": "https://second.example/photo"})
        if request.url.path == "/private":
            return httpx.Response(302, headers={"Location": "https://private.example/photo"})
        return httpx.Response(200, content=png)

    client = httpx.AsyncClient
    monkeypatch.setattr(references, "public_target", target)
    monkeypatch.setattr(
        references.httpx,
        "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs),
    )
    assert await download_reference("https://first.example/redirect", settings) == png
    assert visited == ["first.example", "second.example"]
    with pytest.raises(DomainError, match="Private"):
        await download_reference("https://first.example/private", settings)
    settings.max_upload_bytes = 1
    with pytest.raises(DomainError, match="size limit"):
        await download_reference("https://first.example/photo", settings)


async def test_download_failure_does_not_expose_signed_url(monkeypatch, settings):
    import pixel_art_mcp.projects.references as references

    signed_url = "https://example.com/photo?secret=do-not-log"
    monkeypatch.setattr(
        references,
        "public_target",
        AsyncMock(side_effect=httpx.ConnectError(signed_url)),
    )
    with pytest.raises(DomainError) as error:
        await download_reference(signed_url, settings)
    assert "secret" not in str(error.value)
    assert error.value.__suppress_context__
