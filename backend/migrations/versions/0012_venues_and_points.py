"""Venues own points; admin membership moves from a point to the whole venue.

Data migration (owner decision 28.09.2026): all restaurants of one ``owner_id`` become
the points of one venue named after the owner's earliest point. Admins of any of those
points become admins of the venue; the owner is its creator. This widens access on
purpose: an admin of one point of an owner now manages every point of that owner.

``restaurant_members`` is not dropped but renamed to ``restaurant_members_legacy`` and
kept frozen, so that the downgrade restores exactly the pre-migration memberships.
Downgrade rule per (point, admin): the legacy row when it exists; all points of the venue
for admins and points that appeared after the upgrade; nobody who has left the venue.

Invites become venue-wide (``venue_id``); ``restaurant_id`` stays as the point an invite
was created from and becomes nullable for invites created at venue level.

Revision ID: 0012
Revises: 0011
"""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "venues",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_venues_created_by_id", "venues", ["created_by_id"])

    op.add_column("restaurants", sa.Column("venue_id", sa.Uuid(), nullable=True))
    op.add_column(
        "restaurants",
        sa.Column(
            "timezone", sa.String(length=64), server_default="Europe/Moscow", nullable=False
        ),
    )
    # One venue per owner, named after the owner's earliest point.
    op.execute(
        """
        INSERT INTO venues (id, name, created_by_id, created_at, updated_at)
        SELECT gen_random_uuid(), first_point.name, first_point.owner_id,
               first_point.created_at, now()
        FROM (
            SELECT DISTINCT ON (owner_id) owner_id, name, created_at
            FROM restaurants
            ORDER BY owner_id, created_at, id
        ) AS first_point
        """
    )
    op.execute(
        """
        UPDATE restaurants r
        SET venue_id = v.id
        FROM venues v
        WHERE v.created_by_id = r.owner_id
        """
    )
    op.alter_column("restaurants", "venue_id", nullable=False)
    op.create_foreign_key(
        "restaurants_venue_id_fkey", "restaurants", "venues", ["venue_id"], ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_restaurants_venue_id", "restaurants", ["venue_id"])
    op.create_unique_constraint("uq_restaurants_id_venue", "restaurants", ["id", "venue_id"])

    op.create_table(
        "venue_members",
        sa.Column("venue_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=20), server_default="admin", nullable=False),
        sa.Column("is_creator", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("role = 'admin'", name="ck_venue_member_role"),
        sa.ForeignKeyConstraint(["venue_id"], ["venues.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("venue_id", "user_id"),
    )
    op.create_index(
        "uq_venue_members_creator",
        "venue_members",
        ["venue_id"],
        unique=True,
        postgresql_where=sa.text("is_creator"),
    )
    op.execute(
        """
        INSERT INTO venue_members (venue_id, user_id, role, is_creator, created_at)
        SELECT r.venue_id, m.user_id, 'admin', m.user_id = v.created_by_id, min(m.created_at)
        FROM restaurant_members m
        JOIN restaurants r ON r.id = m.restaurant_id
        JOIN venues v ON v.id = r.venue_id
        GROUP BY r.venue_id, m.user_id, v.created_by_id
        """
    )
    # 0009 guarantees an owner row per point; keep the creator even if it went missing.
    op.execute(
        """
        INSERT INTO venue_members (venue_id, user_id, role, is_creator, created_at)
        SELECT v.id, v.created_by_id, 'admin', true, v.created_at
        FROM venues v
        WHERE NOT EXISTS (
            SELECT 1 FROM venue_members vm
            WHERE vm.venue_id = v.id AND vm.user_id = v.created_by_id
        )
        """
    )

    op.add_column("restaurant_invites", sa.Column("venue_id", sa.Uuid(), nullable=True))
    op.execute(
        """
        UPDATE restaurant_invites i
        SET venue_id = r.venue_id
        FROM restaurants r
        WHERE r.id = i.restaurant_id
        """
    )
    op.alter_column("restaurant_invites", "venue_id", nullable=False)
    op.create_foreign_key(
        "restaurant_invites_venue_id_fkey", "restaurant_invites", "venues", ["venue_id"],
        ["id"], ondelete="CASCADE",
    )
    op.create_index("ix_restaurant_invites_venue_id", "restaurant_invites", ["venue_id"])
    op.alter_column("restaurant_invites", "restaurant_id", nullable=True)

    op.rename_table("restaurant_members", "restaurant_members_legacy")


def downgrade() -> None:
    op.rename_table("restaurant_members_legacy", "restaurant_members")
    op.execute(
        """
        CREATE TEMPORARY TABLE downgraded_members AS
        SELECT r.id AS restaurant_id,
               vm.user_id,
               CASE
                   WHEN legacy.user_id IS NOT NULL THEN legacy.is_creator
                   ELSE vm.user_id = r.owner_id AND NOT EXISTS (
                       SELECT 1 FROM restaurant_members c
                       WHERE c.restaurant_id = r.id AND c.is_creator
                   )
               END AS is_creator,
               COALESCE(legacy.created_at, vm.created_at) AS created_at
        FROM restaurants r
        JOIN venue_members vm ON vm.venue_id = r.venue_id
        LEFT JOIN restaurant_members legacy
            ON legacy.restaurant_id = r.id AND legacy.user_id = vm.user_id
        WHERE legacy.user_id IS NOT NULL
           -- the point appeared after the upgrade
           OR NOT EXISTS (
               SELECT 1 FROM restaurant_members p WHERE p.restaurant_id = r.id
           )
           -- the admin joined the venue after the upgrade
           OR NOT EXISTS (
               SELECT 1
               FROM restaurant_members a
               JOIN restaurants ar ON ar.id = a.restaurant_id
               WHERE a.user_id = vm.user_id AND ar.venue_id = r.venue_id
           )
        """
    )
    op.execute("DELETE FROM restaurant_members")
    op.execute(
        """
        INSERT INTO restaurant_members (restaurant_id, user_id, role, is_creator, created_at)
        SELECT restaurant_id, user_id, 'admin', is_creator, created_at
        FROM downgraded_members
        """
    )
    op.execute("DROP TABLE downgraded_members")

    op.execute(
        """
        UPDATE restaurant_invites i
        SET restaurant_id = (
            SELECT r.id FROM restaurants r
            WHERE r.venue_id = i.venue_id
            ORDER BY r.created_at, r.id
            LIMIT 1
        )
        WHERE i.restaurant_id IS NULL
        """
    )
    op.alter_column("restaurant_invites", "restaurant_id", nullable=False)
    op.drop_index("ix_restaurant_invites_venue_id", table_name="restaurant_invites")
    op.drop_constraint(
        "restaurant_invites_venue_id_fkey", "restaurant_invites", type_="foreignkey"
    )
    op.drop_column("restaurant_invites", "venue_id")

    op.drop_index("uq_venue_members_creator", table_name="venue_members")
    op.drop_table("venue_members")

    op.drop_constraint("uq_restaurants_id_venue", "restaurants", type_="unique")
    op.drop_index("ix_restaurants_venue_id", table_name="restaurants")
    op.drop_constraint("restaurants_venue_id_fkey", "restaurants", type_="foreignkey")
    op.drop_column("restaurants", "timezone")
    op.drop_column("restaurants", "venue_id")
    op.drop_index("ix_venues_created_by_id", table_name="venues")
    op.drop_table("venues")
