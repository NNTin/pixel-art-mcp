import sqlite3

import pytest

from pixel_art_mcp.models import DomainError
from pixel_art_mcp.storage.store import Store, identifier, timestamp


def test_atomic_publication_failure_retains_previous_state(service):
    project = service.create_project("Chair")
    job_id = identifier()
    service.store.insert_job(
        {
            "id": job_id,
            "project_id": str(project.id),
            "operation": "script",
            "status": "running",
            "created_at": timestamp(),
            "params": {},
            "artifact_ids": [],
            "input_revision_id": None,
        },
        32,
    )
    artifact = {"id": identifier(), "project_id": str(project.id)}
    with pytest.raises(sqlite3.IntegrityError):
        service.store.publish(job_id, [artifact, artifact])
    assert service.store.records(str(project.id), "artifact") == []
    assert service.store.job(job_id)["status"] == "running"
    assert service.store.project(str(project.id))["current_revision_id"] is None


def test_recovery_and_queued_jobs_survive_restart(tmp_path):
    store = Store(tmp_path / "db")
    project = store.create_project("Chair")
    ids = []
    for status in ("queued", "running"):
        job_id = identifier()
        ids.append(job_id)
        store.insert_job(
            {
                "id": job_id,
                "project_id": project["id"],
                "operation": "script",
                "status": status,
                "created_at": timestamp(),
            },
            32,
        )
    store.close()
    store = Store(tmp_path / "db")
    store.recover()
    assert store.job(ids[0])["status"] == "queued"
    assert store.job(ids[1])["status"] == "failed"
    assert "stopped" in store.job(ids[1])["error"]
    assert store.claim_job()["id"] == ids[0]
    assert store.claim_job() is None
    store.close()


def test_storage_rejects_traversal_and_external_symlinks(service, tmp_path):
    with pytest.raises(DomainError):
        service.store.path("../outside")
    (service.store.root / "escape").symlink_to(tmp_path)
    with pytest.raises(DomainError):
        service.store.path("escape/file")
