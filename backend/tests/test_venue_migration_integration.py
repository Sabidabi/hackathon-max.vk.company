"""Migrations 0012–0014 on data of the old format: upgrade, invariants, exact downgrade.

Destructive for its database: it drops and recreates the ``public`` schema, so it runs
only with ``RUN_MIGRATION_TEST=1`` and a disposable ``MIGRATION_DATABASE_URL``.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

DATABASE_URL = os.getenv("MIGRATION_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(
    os.getenv("RUN_MIGRATION_TEST") != "1" or not DATABASE_URL,
    reason="requires RUN_MIGRATION_TEST=1 and a disposable MIGRATION_DATABASE_URL",
)
BACKEND = Path(__file__).resolve().parents[1]

U1, U2, U3, U4 = (f"00000000-0000-0000-0000-0000000000a{n}" for n in range(1, 5))
POKROVKA, TVERSKAYA, YUG = (f"00000000-0000-0000-0000-0000000000b{n}" for n in range(1, 4))

SEED = [
    f"""INSERT INTO users (id, max_user_id, display_name, first_name) VALUES
        ('{U1}', 7100000001, 'Owner1', 'O1'), ('{U2}', 7100000002, 'AdminA', 'A2'),
        ('{U3}', 7100000003, 'Owner3', 'O3'), ('{U4}', 7100000004, 'AdminBC', 'A4')""",
    f"""INSERT INTO restaurants (id, public_id, owner_id, name, created_at) VALUES
        ('{POKROVKA}', 'pokrovka', '{U1}', 'Север Покровка', '2026-01-01'),
        ('{TVERSKAYA}', 'tverskaya', '{U1}', 'Север Тверская', '2026-02-01'),
        ('{YUG}', 'yug', '{U3}', 'Юг', '2026-03-01')""",
    f"""INSERT INTO restaurant_members (restaurant_id, user_id, role, is_creator, created_at)
        VALUES ('{POKROVKA}', '{U1}', 'admin', true, '2026-01-01'),
               ('{TVERSKAYA}', '{U1}', 'admin', true, '2026-02-01'),
               ('{POKROVKA}', '{U2}', 'admin', false, '2026-01-05'),
               ('{YUG}', '{U3}', 'admin', true, '2026-03-01'),
               ('{YUG}', '{U4}', 'admin', false, '2026-03-02'),
               ('{TVERSKAYA}', '{U4}', 'admin', false, '2026-02-02')""",
    f"""INSERT INTO restaurant_invites (id, restaurant_id, created_by_id, token_hash, role,
        expires_at) VALUES ('00000000-0000-0000-0000-0000000000c1', '{POKROVKA}', '{U2}',
        repeat('a', 64), 'admin', now() + interval '1 day')""",
    f"""INSERT INTO menus (id, restaurant_id) VALUES
        ('00000000-0000-0000-0000-0000000000d1', '{POKROVKA}'),
        ('00000000-0000-0000-0000-0000000000d2', '{TVERSKAYA}'),
        ('00000000-0000-0000-0000-0000000000d3', '{YUG}')""",
    f"""INSERT INTO menu_versions (id, menu_id, version, status, created_by_id, published_at)
        VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1',
                1, 'draft', '{U1}', NULL),
               ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d1',
                2, 'archived', '{U1}', '2026-01-10'),
               ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000d1',
                3, 'published', '{U2}', '2026-01-20'),
               ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000d2',
                1, 'draft', '{U1}', NULL),
               ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000d3',
                1, 'draft', '{U3}', NULL)""",
    """UPDATE menus SET current_published_version_id = '00000000-0000-0000-0000-0000000000e3'
        WHERE id = '00000000-0000-0000-0000-0000000000d1'""",
    """INSERT INTO menu_sections (id, menu_version_id, name, sort_order) VALUES
        ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1',
         'Кофе', 0),
        ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e2',
         'Кофе', 0),
        ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e3',
         'Кофе ', 0)""",
    """INSERT INTO menu_items (id, section_id, name, price_minor, currency, allergens,
        configuration, is_available, sort_order) VALUES
        (gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', 'Латте', 19000, 'RUB',
         '[]', '{}', true, 0),
        (gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', 'Латте', 21000, 'RUB',
         '[]', '{}', true, 1),
        (gen_random_uuid(), '00000000-0000-0000-0000-0000000000f2', 'Латте', 17000, 'RUB',
         '[]', '{}', true, 0),
        (gen_random_uuid(), '00000000-0000-0000-0000-0000000000f3', 'латте', 19000, 'RUB',
         '[]', '{}', true, 0)""",
]

SNAPSHOT = [
    "SELECT id, public_id, owner_id, name FROM restaurants ORDER BY id",
    "SELECT restaurant_id, user_id, role, is_creator, created_at FROM restaurant_members "
    "ORDER BY restaurant_id, user_id",
    "SELECT id, restaurant_id, created_by_id FROM restaurant_invites ORDER BY id",
    "SELECT id, restaurant_id, current_published_version_id FROM menus ORDER BY id",
    "SELECT id, menu_id, version, status FROM menu_versions ORDER BY id",
    "SELECT id, section_id, name, price_minor FROM menu_items ORDER BY id",
]


def alembic(*args: str) -> None:
    env = {**os.environ, "DATABASE_URL": DATABASE_URL}
    subprocess.run(
        [sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=env, check=True,
        capture_output=True,
    )


async def rows(connection, sql: str) -> list[tuple]:
    return [tuple(row) for row in (await connection.execute(text(sql))).all()]


@pytest.mark.asyncio
async def test_venue_migrations_on_old_format_data_round_trip() -> None:
    engine = create_async_engine(DATABASE_URL)
    try:
        async with engine.begin() as connection:
            await connection.execute(text("DROP SCHEMA public CASCADE"))
            await connection.execute(text("CREATE SCHEMA public"))
        alembic("upgrade", "0011")
        async with engine.begin() as connection:
            for statement in SEED:
                await connection.execute(text(statement))
        async with engine.connect() as connection:
            before = [await rows(connection, sql) for sql in SNAPSHOT]

        alembic("upgrade", "head")
        async with engine.connect() as connection:
            venues = await rows(connection, """
                SELECT v.created_by_id::text, v.name,
                       array_agg(r.public_id ORDER BY r.public_id)
                FROM venues v JOIN restaurants r ON r.venue_id = v.id
                GROUP BY v.id ORDER BY v.name""")
            assert venues == [
                (U1, "Север Покровка", ["pokrovka", "tverskaya"]),
                (U3, "Юг", ["yug"]),
            ]
            members = await rows(connection, """
                SELECT v.name, m.user_id::text, m.is_creator FROM venue_members m
                JOIN venues v ON v.id = m.venue_id ORDER BY 1, 2""")
            assert members == [
                ("Север Покровка", U1, True), ("Север Покровка", U2, False),
                ("Север Покровка", U4, False), ("Юг", U3, True), ("Юг", U4, False),
            ]
            assignments = await rows(connection, """
                SELECT r.public_id, m.id::text, m.title, m.source, pm.sort_order
                FROM point_menus pm JOIN menus m ON m.id = pm.menu_id
                JOIN restaurants r ON r.id = pm.point_id ORDER BY 1""")
            assert [row[0] for row in assignments] == ["pokrovka", "tverskaya", "yug"]
            assert {row[2:] for row in assignments} == {("Основное", "manual", 0)}
            assert assignments[0][1] == "00000000-0000-0000-0000-0000000000d1"
            # The same position shares one key across the draft and every published version,
            # also when only the letter case or spaces differ; duplicates stay distinct.
            keys = await rows(connection, """
                SELECT s.menu_version_id::text, i.sort_order, i.item_key::text
                FROM menu_items i JOIN menu_sections s ON s.id = i.section_id
                ORDER BY 1, 2""")
            by_version = {}
            for version_id, _, key in keys:
                by_version.setdefault(version_id[-2:], []).append(key)
            assert by_version["e1"][0] == by_version["e2"][0] == by_version["e3"][0]
            assert by_version["e1"][1] != by_version["e1"][0]
            assert await rows(connection, "SELECT count(*) FROM external_refs") == [(0,)]
            assert await rows(connection, """
                SELECT count(*) FROM restaurant_invites i JOIN restaurants r
                ON r.id = i.restaurant_id WHERE i.venue_id = r.venue_id""") == [(1,)]

        alembic("check")
        alembic("downgrade", "0011")
        async with engine.connect() as connection:
            after = [await rows(connection, sql) for sql in SNAPSHOT]
        assert after == before
        alembic("upgrade", "head")
    finally:
        await engine.dispose()
