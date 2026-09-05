from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from pixel_art_mcp.models import DomainError, Project, ProjectDetail, Reference
from pixel_art_mcp.projects.service import Service


class CreateProject(BaseModel):
    name: str = Field(min_length=1, max_length=120)


def routes(service: Service) -> APIRouter:
    router = APIRouter()

    @router.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/health/ready")
    async def ready() -> JSONResponse:
        good = service.worker_ready and service.blender_version is not None
        return JSONResponse(
            {"ready": good, "blender_version": service.blender_version},
            status_code=200 if good else 503,
        )

    @router.post("/projects", response_model=Project, status_code=201)
    async def create_project(body: CreateProject) -> Project:
        return service.create_project(body.name)

    @router.get("/projects", response_model=list[Project])
    async def list_projects() -> list[Project]:
        return service.list_projects()

    @router.get("/projects/{project_id}", response_model=ProjectDetail)
    async def get_project(project_id: UUID) -> ProjectDetail:
        return service.get_project(str(project_id))

    @router.post("/projects/{project_id}/references", response_model=Reference, status_code=201)
    async def upload_reference(project_id: UUID, file: Annotated[UploadFile, File()]) -> Reference:
        service.store.project(str(project_id))
        data = bytearray()
        try:
            while chunk := await file.read(65536):
                data.extend(chunk)
                if len(data) > service.settings.max_upload_bytes:
                    raise DomainError("Reference exceeds the upload size limit", 413)
            return await service.add_reference(
                str(project_id), bytes(data), file.filename or "image"
            )
        finally:
            await file.close()

    @router.get("/artifacts/{artifact_id}")
    async def download_artifact(artifact_id: UUID) -> FileResponse:
        artifact = service.artifact(str(artifact_id))
        return FileResponse(
            service.artifact_path(str(artifact_id)),
            filename=artifact.filename,
            media_type=artifact.media_type,
            headers={"X-Content-Type-Options": "nosniff"},
        )

    return router
