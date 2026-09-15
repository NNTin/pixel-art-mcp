"""Bounded binary delivery for clients with no HTTP or resource-reading tools."""

import base64
import hashlib
from pathlib import Path
from typing import Annotated
from uuid import UUID

from pydantic import Field, StrictInt

from pixel_art_mcp.models import Artifact, DomainError, Model

MAX_INLINE_ARTIFACT_BYTES = 1_048_576
MAX_ARTIFACT_CHUNK_BYTES = 262_144
ArtifactOffset = Annotated[StrictInt, Field(ge=0, le=2**63 - 1)]
ArtifactLength = Annotated[StrictInt, Field(ge=1, le=MAX_ARTIFACT_CHUNK_BYTES)]


class ArtifactChunk(Model):
    artifact_id: UUID
    filename: str
    media_type: str
    size_bytes: int = Field(description="Total raw file size, not base64 length.")
    offset: int = Field(description="Starting raw byte offset of this chunk.")
    bytes_read: int
    next_offset: int | None = Field(description="Pass as offset for the next call; null means EOF.")
    data_base64: str = Field(
        description="Decode each chunk separately, then concatenate raw bytes in offset order."
    )
    sha256: str = Field(
        description="SHA-256 hex digest of this chunk's decoded bytes, not the whole file."
    )


def read_artifact_chunk(path: Path, artifact: Artifact, offset: int, length: int) -> ArtifactChunk:
    if (
        type(offset) is not int
        or offset < 0
        or type(length) is not int
        or not 1 <= length <= MAX_ARTIFACT_CHUNK_BYTES
    ):
        raise DomainError("offset must be a nonnegative integer; length must be 1..262144 bytes")
    with path.open("rb") as stream:
        if path.stat().st_size != artifact.size_bytes:
            raise DomainError("Artifact size changed; refusing inconsistent byte delivery", 409)
        if offset > artifact.size_bytes:
            raise DomainError("offset exceeds artifact size_bytes")
        stream.seek(offset)
        data = stream.read(length)
    if len(data) != min(length, artifact.size_bytes - offset):
        raise DomainError("Artifact was truncated while reading", 409)
    end = offset + len(data)
    return ArtifactChunk(
        artifact_id=artifact.id,
        filename=artifact.filename,
        media_type=artifact.media_type,
        size_bytes=artifact.size_bytes,
        offset=offset,
        bytes_read=len(data),
        next_offset=end if end < artifact.size_bytes else None,
        data_base64=base64.b64encode(data).decode("ascii"),
        sha256=hashlib.sha256(data).hexdigest(),
    )
