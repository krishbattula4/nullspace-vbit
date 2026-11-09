import os
import sqlite3
import subprocess
import sys
from pathlib import Path


def test_migrations_lifecycle(tmp_path: Path) -> None:
    backend_dir = Path(__file__).resolve().parent.parent
    db_file = tmp_path / "migration_lifecycle_test.db"
    db_url = f"sqlite+aiosqlite:///{db_file.as_posix()}"

    env = os.environ.copy()
    env["DATABASE_URL"] = db_url
    env["APP_ENV"] = "test"

    # Step 1: Upgrade to head
    res_up1 = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    assert (
        res_up1.returncode == 0
    ), f"alembic upgrade head failed:\n{res_up1.stderr}\n{res_up1.stdout}"

    # Step 2: Downgrade to base
    res_down = subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "base"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    assert (
        res_down.returncode == 0
    ), f"alembic downgrade base failed:\n{res_down.stderr}\n{res_down.stdout}"

    # Step 3: Upgrade to head again
    res_up2 = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    assert (
        res_up2.returncode == 0
    ), f"alembic upgrade head (second run) failed:\n{res_up2.stderr}\n{res_up2.stdout}"

    # Step 4: Verify users table exists with sqlite3 module
    conn = sqlite3.connect(db_file)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='users';")
        row = cur.fetchone()
        assert row is not None, "Table 'users' was not found in sqlite_master"
        assert row[0] == "users"

        cur.execute("PRAGMA table_info(users);")
        columns = {col[1] for col in cur.fetchall()}
        expected_columns = {"user_id", "username", "password_hash", "display_name", "created_at"}
        assert expected_columns.issubset(
            columns
        ), f"Missing expected columns: {expected_columns - columns}"
    finally:
        conn.close()
