"""Application settings. Every value comes from the environment (see .env.example)."""
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"

    postgres_user: str = "nullspace"
    postgres_password: str = "nullspace_dev_password"
    postgres_db: str = "nullspace"
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    database_url: str | None = Field(
        default=None, description="Full SQLAlchemy URL; overrides the POSTGRES_* fields when set"
    )

    jwt_secret: str = "change-me"
    jwt_access_minutes: int = 15
    jwt_refresh_days: int = 7
    cors_origins: str = "http://localhost:5173"
    media_dir: str = "./media"
    max_message_bytes: int = 65536

    @property
    def sqlalchemy_url(self) -> str:
        if self.database_url:
            return self.database_url
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
