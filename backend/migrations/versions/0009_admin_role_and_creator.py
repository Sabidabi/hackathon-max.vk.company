"""Collapse owner/manager/editor into one admin role with an is_creator attribute.

Every restaurant owner is guaranteed a membership row, so membership alone decides
access. The creator is an attribute, not a role: at most one per restaurant.

Downgrade is lossy and cannot be undone: the creator becomes ``owner`` and every other
admin becomes ``manager``. Former ``editor`` members are not remembered, so after a
downgrade they are managers (with publish rights) and a later upgrade cannot restore them.

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Owners created before membership rows existed still need one.
    op.execute(
        """
        INSERT INTO restaurant_members (restaurant_id, user_id, role, created_at)
        SELECT r.id, r.owner_id, 'owner', r.created_at
        FROM restaurants r
        WHERE NOT EXISTS (
            SELECT 1 FROM restaurant_members m
            WHERE m.restaurant_id = r.id AND m.user_id = r.owner_id
        )
        """
    )
    op.add_column(
        "restaurant_members",
        sa.Column("is_creator", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.execute(
        """
        UPDATE restaurant_members m
        SET is_creator = true
        FROM restaurants r
        WHERE r.id = m.restaurant_id AND r.owner_id = m.user_id
        """
    )
    op.drop_constraint("ck_member_role", "restaurant_members", type_="check")
    op.execute("UPDATE restaurant_members SET role = 'admin'")
    op.alter_column("restaurant_members", "role", server_default="admin")
    op.create_check_constraint("ck_member_role", "restaurant_members", "role = 'admin'")
    op.create_index(
        "uq_restaurant_members_creator",
        "restaurant_members",
        ["restaurant_id"],
        unique=True,
        postgresql_where=sa.text("is_creator"),
    )

    op.drop_constraint("ck_invite_role", "restaurant_invites", type_="check")
    op.execute("UPDATE restaurant_invites SET role = 'admin'")
    op.alter_column("restaurant_invites", "role", server_default="admin")
    op.create_check_constraint("ck_invite_role", "restaurant_invites", "role = 'admin'")


def downgrade() -> None:
    op.drop_constraint("ck_invite_role", "restaurant_invites", type_="check")
    op.alter_column("restaurant_invites", "role", server_default=None)
    op.execute("UPDATE restaurant_invites SET role = 'manager'")
    op.create_check_constraint(
        "ck_invite_role", "restaurant_invites", "role IN ('manager', 'editor')"
    )

    op.drop_index("uq_restaurant_members_creator", table_name="restaurant_members")
    op.drop_constraint("ck_member_role", "restaurant_members", type_="check")
    op.alter_column("restaurant_members", "role", server_default=None)
    op.execute(
        "UPDATE restaurant_members SET role = CASE WHEN is_creator THEN 'owner' ELSE 'manager' END"
    )
    op.drop_column("restaurant_members", "is_creator")
    op.create_check_constraint(
        "ck_member_role", "restaurant_members", "role IN ('owner', 'manager', 'editor')"
    )
