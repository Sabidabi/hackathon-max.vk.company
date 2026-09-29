"""Menu library of the venue, menu-to-point assignments and a stable ``item_key``.

Menus belong to the venue (``venue_id``, ``title``, ``source`` manual | iiko,
``archived_at``) and reach guests through ``point_menus`` (tab order, optional local
show hours). Composite foreign keys ``(point_id, venue_id)`` and ``(menu_id, venue_id)``
make the database refuse assigning a menu of another venue.

Data migration: the single menu of every point becomes the library menu «Основное»
(``source = manual``) assigned to that point at position 0. Menu, version and item IDs are
kept, so published snapshots and ``/r/:public_id`` keep working unchanged.

``menu_items.item_key`` identifies a position across all versions of its menu. Backfill:
a deterministic UUID from (menu, section name, item name, occurrence), so the draft and
every published version of one menu share keys for the same position.

Downgrade restores one menu per point: each point keeps its first assigned menu that no
earlier point took; points left without a menu get an empty «Основное» with a draft; menus
assigned to no point are deleted (they can only come from after the upgrade).

Revision ID: 0013
Revises: 0012
"""

import hashlib
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("menus", sa.Column("venue_id", sa.Uuid(), nullable=True))
    op.add_column(
        "menus",
        sa.Column("title", sa.String(length=120), server_default="Основное", nullable=False),
    )
    op.alter_column("menus", "title", server_default=None)
    op.add_column(
        "menus",
        sa.Column("source", sa.String(length=16), server_default="manual", nullable=False),
    )
    op.add_column(
        "menus", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute(
        """
        UPDATE menus m
        SET venue_id = r.venue_id
        FROM restaurants r
        WHERE r.id = m.restaurant_id
        """
    )
    op.alter_column("menus", "venue_id", nullable=False)
    op.create_foreign_key(
        "menus_venue_id_fkey", "menus", "venues", ["venue_id"], ["id"], ondelete="CASCADE"
    )
    op.create_index("ix_menus_venue_id", "menus", ["venue_id"])
    op.create_unique_constraint("uq_menus_id_venue", "menus", ["id", "venue_id"])
    op.create_check_constraint("ck_menu_source", "menus", "source IN ('manual', 'iiko')")

    op.create_table(
        "point_menus",
        sa.Column("point_id", sa.Uuid(), nullable=False),
        sa.Column("menu_id", sa.Uuid(), nullable=False),
        sa.Column("venue_id", sa.Uuid(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("show_from", sa.Time(), nullable=True),
        sa.Column("show_to", sa.Time(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["point_id", "venue_id"],
            ["restaurants.id", "restaurants.venue_id"],
            name="fk_point_menus_point_venue",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["menu_id", "venue_id"],
            ["menus.id", "menus.venue_id"],
            name="fk_point_menus_menu_venue",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("point_id", "menu_id"),
        sa.UniqueConstraint("point_id", "sort_order", name="uq_point_menus_sort_order"),
        sa.CheckConstraint(
            "(show_from IS NULL) = (show_to IS NULL)", name="ck_point_menus_hours_pair"
        ),
        sa.CheckConstraint(
            "show_from IS NULL OR show_from <> show_to", name="ck_point_menus_hours_span"
        ),
        sa.CheckConstraint("sort_order >= 0", name="ck_point_menus_sort_order"),
    )
    op.create_index("ix_point_menus_menu_id", "point_menus", ["menu_id"])
    op.create_index("ix_point_menus_venue_id", "point_menus", ["venue_id"])
    op.execute(
        """
        INSERT INTO point_menus (point_id, menu_id, venue_id, sort_order)
        SELECT restaurant_id, id, venue_id, 0 FROM menus
        """
    )
    op.drop_index("ix_menus_restaurant_id", table_name="menus")
    op.drop_column("menus", "restaurant_id")

    op.add_column("menu_items", sa.Column("item_key", sa.Uuid(), nullable=True))
    # Keys are computed in Python: PostgreSQL lower() depends on the database locale and
    # does not fold Cyrillic under the C locale, while the API matches with str.casefold().
    bind = op.get_bind()
    rows = bind.execute(sa.text(
        """
        SELECT item.id, version.menu_id, version.id, section.name, item.name
        FROM menu_items item
        JOIN menu_sections section ON section.id = item.section_id
        JOIN menu_versions version ON version.id = section.menu_version_id
        ORDER BY version.id, section.sort_order, item.sort_order
        """
    )).all()
    occurrences: dict[tuple, int] = {}
    updates = []
    for item_id, menu_id, version_id, section_name, item_name in rows:
        base = (version_id, section_name.strip().casefold(), item_name.strip().casefold())
        occurrences[base] = occurrences.get(base, 0) + 1
        seed = f"{menu_id}|{base[1]}|{base[2]}|{occurrences[base]}"
        updates.append({"id": item_id, "key": uuid.UUID(hashlib.md5(seed.encode()).hexdigest())})
    for start in range(0, len(updates), 1000):
        bind.execute(
            sa.text("UPDATE menu_items SET item_key = :key WHERE id = :id"),
            updates[start:start + 1000],
        )
    op.alter_column("menu_items", "item_key", nullable=False)
    op.create_index("ix_menu_items_item_key", "menu_items", ["item_key"])


def downgrade() -> None:
    op.drop_index("ix_menu_items_item_key", table_name="menu_items")
    op.drop_column("menu_items", "item_key")

    op.add_column("menus", sa.Column("restaurant_id", sa.Uuid(), nullable=True))
    bind = op.get_bind()
    points = bind.execute(sa.text(
        "SELECT id, venue_id, owner_id FROM restaurants ORDER BY created_at, id"
    )).all()
    assignments = bind.execute(sa.text(
        "SELECT point_id, menu_id FROM point_menus ORDER BY point_id, sort_order"
    )).all()
    menus_by_point: dict[uuid.UUID, list[uuid.UUID]] = {}
    for point_id, menu_id in assignments:
        menus_by_point.setdefault(point_id, []).append(menu_id)
    taken: set[uuid.UUID] = set()
    for point_id, venue_id, owner_id in points:
        menu_id = next(
            (candidate for candidate in menus_by_point.get(point_id, [])
             if candidate not in taken),
            None,
        )
        if menu_id is None:
            menu_id = uuid.uuid4()
            bind.execute(
                sa.text(
                    "INSERT INTO menus (id, venue_id, title, source) "
                    "VALUES (:id, :venue_id, 'Основное', 'manual')"
                ),
                {"id": menu_id, "venue_id": venue_id},
            )
            bind.execute(
                sa.text(
                    "INSERT INTO menu_versions (id, menu_id, version, status, created_by_id) "
                    "VALUES (:id, :menu_id, 1, 'draft', :owner_id)"
                ),
                {"id": uuid.uuid4(), "menu_id": menu_id, "owner_id": owner_id},
            )
        taken.add(menu_id)
        bind.execute(
            sa.text("UPDATE menus SET restaurant_id = :point_id WHERE id = :menu_id"),
            {"point_id": point_id, "menu_id": menu_id},
        )
    op.execute("DELETE FROM menus WHERE restaurant_id IS NULL")
    op.alter_column("menus", "restaurant_id", nullable=False)
    op.create_foreign_key(
        "menus_restaurant_id_fkey", "menus", "restaurants", ["restaurant_id"], ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_menus_restaurant_id", "menus", ["restaurant_id"], unique=True)

    op.drop_index("ix_point_menus_venue_id", table_name="point_menus")
    op.drop_index("ix_point_menus_menu_id", table_name="point_menus")
    op.drop_table("point_menus")
    op.drop_constraint("ck_menu_source", "menus", type_="check")
    op.drop_constraint("uq_menus_id_venue", "menus", type_="unique")
    op.drop_index("ix_menus_venue_id", table_name="menus")
    op.drop_constraint("menus_venue_id_fkey", "menus", type_="foreignkey")
    op.drop_column("menus", "archived_at")
    op.drop_column("menus", "source")
    op.drop_column("menus", "title")
    op.drop_column("menus", "venue_id")
