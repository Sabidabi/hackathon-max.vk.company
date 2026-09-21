"""Create users and restaurants.

Revision ID: 0001
Revises:
Create Date: 2026-09-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("max_user_id", sa.BigInteger(), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=False),
        sa.Column("username", sa.String(length=100), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_max_user_id", "users", ["max_user_id"], unique=True)

    op.create_table(
        "restaurants",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("public_id", sa.String(length=32), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.String(length=1000), nullable=True),
        sa.Column("address", sa.String(length=500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_restaurants_public_id",
        "restaurants",
        ["public_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_restaurants_public_id", table_name="restaurants")
    op.drop_table("restaurants")
    op.drop_index("ix_users_max_user_id", table_name="users")
    op.drop_table("users")
