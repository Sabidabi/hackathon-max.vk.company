"""Link invites: the target MAX ID becomes optional; index for the creation rate limit.

Revision ID: 0010
Revises: 0009
"""

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("restaurant_invites", "target_max_user_id", nullable=True)
    op.create_index(
        "ix_restaurant_invites_created_by_created_at",
        "restaurant_invites",
        ["created_by_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_restaurant_invites_created_by_created_at", table_name="restaurant_invites"
    )
    # Link invites have no target and cannot exist in the old schema; they are one-time,
    # expire within 24 hours and carry no membership, so dropping them loses no access.
    op.execute("DELETE FROM restaurant_invites WHERE target_max_user_id IS NULL")
    op.alter_column("restaurant_invites", "target_max_user_id", nullable=False)
