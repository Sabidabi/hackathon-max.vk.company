"""Add restaurant site builder state.

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.sites.schemas import default_site_config

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "restaurant_sites",
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "draft_config",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "published_config",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("published_version", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("restaurant_id"),
    )
    restaurant_ids = sa.table("restaurants", sa.column("id", sa.Uuid()))
    site_table = sa.table(
        "restaurant_sites",
        sa.column("restaurant_id", sa.Uuid()),
        sa.column("draft_config", postgresql.JSONB()),
        sa.column("published_version", sa.Integer()),
    )
    connection = op.get_bind()
    for restaurant_id in connection.execute(sa.select(restaurant_ids.c.id)).scalars():
        connection.execute(
            site_table.insert().values(
                restaurant_id=restaurant_id,
                draft_config=default_site_config(),
                published_version=0,
            )
        )
    op.alter_column("restaurant_sites", "published_version", server_default=None)


def downgrade() -> None:
    op.drop_table("restaurant_sites")
