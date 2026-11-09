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
    res_down_base = subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "base"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    assert (
        res_down_base.returncode == 0
    ), f"alembic downgrade base failed:\n{res_down_base.stderr}\n{res_down_base.stdout}"

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

    # Step 4: Verify all tables and users columns exist after upgrade head
    conn = sqlite3.connect(db_file)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = {row[0] for row in cur.fetchall()}

        expected_tables = {
            "users",
            "refresh_tokens",
            "conversations",
            "prekeys",
            "messages",
            "message_versions",
            "media",
        }
        assert expected_tables.issubset(
            tables
        ), f"Missing tables after upgrade head: {expected_tables - tables}"

        # Verify users columns include identity_key and registration_id
        cur.execute("PRAGMA table_info(users);")
        users_columns = {col[1] for col in cur.fetchall()}
        expected_users_columns = {
            "user_id",
            "username",
            "password_hash",
            "display_name",
            "created_at",
            "identity_key",
            "registration_id",
        }
        assert expected_users_columns.issubset(
            users_columns
        ), f"Missing columns in users: {expected_users_columns - users_columns}"

        # Verify refresh_tokens columns
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
        ), f"Missing columns in refresh_tokens: {expected_rt_columns - rt_columns}"
    finally:
        conn.close()

    # Step 5: Downgrade one revision (-1) to remove P1.5 schema additions
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

    # Step 6: Verify P1.5 tables and users columns disappear while users and refresh_tokens remain
    conn = sqlite3.connect(db_file)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables_after_down = {row[0] for row in cur.fetchall()}

        p1_5_tables = {"conversations", "prekeys", "messages", "message_versions", "media"}
        assert p1_5_tables.isdisjoint(
            tables_after_down
        ), f"P1.5 tables still exist after downgrade -1: {tables_after_down & p1_5_tables}"

        assert "users" in tables_after_down, "Table 'users' should still exist after downgrade -1"
        assert (
            "refresh_tokens" in tables_after_down
        ), "Table 'refresh_tokens' should still exist after downgrade -1"

        # Verify identity_key and registration_id are removed from users
        cur.execute("PRAGMA table_info(users);")
        users_columns_after_down = {col[1] for col in cur.fetchall()}
        p1_5_user_cols = {"identity_key", "registration_id"}
        assert p1_5_user_cols.isdisjoint(
            users_columns_after_down
        ), f"P1.5 columns still exist in users: {users_columns_after_down & p1_5_user_cols}"
    finally:
        conn.close()

    # Step 7: Downgrade to base succeeds from -1
    res_down_base2 = subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "base"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    assert (
        res_down_base2.returncode == 0
    ), f"alembic downgrade base failed:\n{res_down_base2.stderr}\n{res_down_base2.stdout}"

    # Step 8: Upgrade to head again and verify all tables reappear
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
        cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables_final = {row[0] for row in cur.fetchall()}
        assert expected_tables.issubset(
            tables_final
        ), f"Missing tables after final upgrade head: {expected_tables - tables_final}"
    finally:
        conn.close()
