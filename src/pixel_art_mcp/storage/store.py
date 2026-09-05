import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from pixel_art_mcp.models import DomainError


def identifier() -> str:
    return str(uuid4())


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


class Store:
    """Short transactions; only the service process owns the database."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.transaction_depth = 0
        self.db = sqlite3.connect(self.root / "state.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1):
            raise RuntimeError(f"Unsupported database schema {version}")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
                current_revision_id TEXT
            );
            CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                kind TEXT NOT NULL, payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS records_project ON records(project_id, kind);
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                operation TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, created_at);
            PRAGMA user_version=1;
        """)

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.lock:
            outer = self.transaction_depth == 0
            if outer:
                self.db.execute("BEGIN IMMEDIATE")
            self.transaction_depth += 1
            try:
                yield self.db
                if outer:
                    self.db.commit()
            except BaseException:
                if outer:
                    self.db.rollback()
                raise
            finally:
                self.transaction_depth -= 1

    def path(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root) or path == self.root:
            raise DomainError("Invalid storage path")
        return path

    def project(self, project_id: str) -> dict[str, Any]:
        with self.lock:
            row = self.db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            raise DomainError("Project not found", 404)
        return dict(row)

    def create_project(self, name: str) -> dict[str, Any]:
        project_id = identifier()
        with self.transaction() as db:
            db.execute(
                "INSERT INTO projects VALUES (?, ?, ?, NULL)", (project_id, name, timestamp())
            )
        return self.project(project_id)

    def projects(self) -> list[dict[str, Any]]:
        with self.lock:
            return [
                dict(row)
                for row in self.db.execute("SELECT * FROM projects ORDER BY created_at DESC")
            ]

    def put_record(self, kind: str, record: dict[str, Any]) -> None:
        with self.transaction() as db:
            db.execute(
                "INSERT INTO records VALUES (?, ?, ?, ?)",
                (record["id"], record["project_id"], kind, json.dumps(record)),
            )

    def record(self, record_id: str, kind: str) -> dict[str, Any]:
        with self.lock:
            row = self.db.execute(
                "SELECT payload FROM records WHERE id=? AND kind=?", (record_id, kind)
            ).fetchone()
        if row is None:
            raise DomainError(f"{kind.capitalize()} not found", 404)
        result: dict[str, Any] = json.loads(row[0])
        return result

    def records(self, project_id: str, kind: str) -> list[dict[str, Any]]:
        with self.lock:
            return [
                json.loads(row[0])
                for row in self.db.execute(
                    "SELECT payload FROM records WHERE project_id=? AND kind=? ORDER BY rowid",
                    (project_id, kind),
                )
            ]

    def insert_job(self, job: dict[str, Any], max_pending: int) -> None:
        with self.transaction() as db:
            pending = db.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued', 'running')"
            ).fetchone()[0]
            if pending >= max_pending:
                raise DomainError("Job queue is full; wait for a job to finish", 429)
            db.execute(
                "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)",
                (
                    job["id"],
                    job["project_id"],
                    job["operation"],
                    job["status"],
                    job["created_at"],
                    json.dumps(job),
                ),
            )

    def job(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            row = self.db.execute("SELECT payload FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise DomainError("Job not found", 404)
        result: dict[str, Any] = json.loads(row[0])
        return result

    def update_job(self, job_id: str, **changes: Any) -> dict[str, Any]:
        with self.transaction() as db:
            job = self.job(job_id)
            job.update(changes)
            db.execute(
                "UPDATE jobs SET status=?, payload=? WHERE id=?",
                (job["status"], json.dumps(job), job_id),
            )
            return job

    def claim_job(self) -> dict[str, Any] | None:
        with self.transaction() as db:
            row = db.execute(
                "SELECT id FROM jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            return self.update_job(
                row[0], status="running", stage="starting", started_at=timestamp()
            )

    def recover(self) -> None:
        with self.transaction() as db:
            rows = db.execute("SELECT id FROM jobs WHERE status='running'").fetchall()
            for row in rows:
                self.update_job(
                    row[0],
                    status="failed",
                    stage="interrupted",
                    error="Service stopped during execution; submit a new job to retry",
                    finished_at=timestamp(),
                )

    def publish(
        self, job_id: str, artifacts: list[dict[str, Any]], revision: dict[str, Any] | None = None
    ) -> None:
        with self.transaction() as db:
            job = self.job(job_id)
            if job["status"] != "running":
                raise DomainError("Job is no longer running", 409)
            if revision is not None:
                current = self.project(job["project_id"])["current_revision_id"]
                if current != job["input_revision_id"]:
                    raise DomainError("Scene revision changed; reload the project and retry", 409)
            for artifact in artifacts:
                db.execute(
                    "INSERT INTO records VALUES (?, ?, 'artifact', ?)",
                    (artifact["id"], job["project_id"], json.dumps(artifact)),
                )
            if revision is not None:
                db.execute(
                    "INSERT INTO records VALUES (?, ?, 'revision', ?)",
                    (revision["id"], job["project_id"], json.dumps(revision)),
                )
                db.execute(
                    "UPDATE projects SET current_revision_id=? WHERE id=?",
                    (revision["id"], job["project_id"]),
                )
            # One commit publishes the revision, artifacts, and successful job together.
            job.update(
                status="succeeded",
                stage="complete",
                progress=1.0,
                finished_at=timestamp(),
                artifact_ids=[a["id"] for a in artifacts],
                result_revision_id=revision["id"] if revision else None,
            )
            db.execute(
                "UPDATE jobs SET status='succeeded', payload=? WHERE id=?",
                (json.dumps(job), job_id),
            )
