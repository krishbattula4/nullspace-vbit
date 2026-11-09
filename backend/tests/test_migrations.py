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
        ), f"Missing expected columns in users: {expected_columns - columns}"

        # Verify refresh_tokens table exists after upgrade to head
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='refresh_tokens';")
        rt_row = cur.fetchone()
        assert rt_row is not None, "Table 'refresh_tokens' was not found in sqlite_master"
        assert rt_row[0] == "refresh_tokens"

        cur.execute("PRAGMA table_info(refresh_tokens);")
        rt_columns = {col[1] for col in cur.fetchall()}
        expected_rt_columns = {
            "jti",
            "user_id",
            "expires_at",
            "revoked_at",
            "replaced_by_jti",
            "created_at",
        }
        assert expected_rt_columns.issubset(
            rt_columns
        ), f"Missing expected columns in refresh_tokens: {expected_rt_columns - rt_columns}"
    finally:
        conn.close()

    # Step 5: Downgrade one revision (-1) to remove refresh_tokens table
    res_down_one = subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "-1"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    assert (
        res_down_one.returncode == 0
    ), f"alembic downgrade -1 failed:\n{res_down_one.stderr}\n{res_down_one.stdout}"

    # Step 6: Verify refresh_tokens disappears but users remains
    conn = sqlite3.connect(db_file)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='refresh_tokens';")
        assert (
            cur.fetchone() is None
        ), "Table 'refresh_tokens' should have been removed after downgrade -1"

        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='users';")
        assert (
            cur.fetchone() is not None
        ), "Table 'users' should still exist after downgrading refresh_tokens revision"
    finally:
        conn.close()

    # Step 7: Upgrade to head again and verify refresh_tokens reappears
    res_up3 = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    assert (
        res_up3.returncode == 0
    ), f"alembic upgrade head (third run) failed:\n{res_up3.stderr}\n{res_up3.stdout}"

    conn = sqlite3.connect(db_file)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='refresh_tokens';")
        assert cur.fetchone() is not None, "Table 'refresh_tokens' was not found after re-upgrade"
    finally:
        conn.close()
