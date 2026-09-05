from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PIXEL_", env_file=".env", extra="ignore")

    data_dir: Path = Path("data")
    base_url: str = "http://localhost:8000"
    listen_host: str = "127.0.0.1"
    blender_binary: str = "blender"
    blender_threads: int = Field(default=2, ge=1, le=64)
    script_timeout: float = Field(default=120, gt=0, le=3600)
    render_timeout: float = Field(default=600, gt=0, le=86400)
    max_upload_bytes: int = Field(default=20 * 1024 * 1024, ge=1)
    max_image_pixels: int = Field(default=40_000_000, ge=1)
    max_script_bytes: int = Field(default=256 * 1024, ge=1)
    max_render_frames: int = Field(default=256, ge=1)
    max_sheet_pixels: int = Field(default=16_777_216, ge=1)
    max_pending_jobs: int = Field(default=32, ge=1)
    max_log_bytes: int = Field(default=64 * 1024, ge=1024)
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "[::1]"]
    allowed_origins: list[str] = ["http://localhost:8000", "http://127.0.0.1:8000"]
