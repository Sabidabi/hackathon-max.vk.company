"""Product analytics (P1-PLAN-10): append-only events, empty-search aggregate, daily roll-up.

New tables only; nothing existing is touched.

Revision ID: 0017
Revises: 0016
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0017"
down_revision: str | Sequence[str] | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "events",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("client_event_id", sa.Uuid(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "received_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("venue_id", sa.Uuid(), nullable=False),
        sa.Column("point_id", sa.Uuid(), nullable=False),
        sa.Column("menu_version_id", sa.Uuid(), nullable=True),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("platform", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column(
            "props", postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"), nullable=False,
        ),
        sa.Column("is_synthetic", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.CheckConstraint(
            "platform IN ('max_ios', 'max_android', 'max_web', 'web')", name="ck_events_platform"
        ),
        sa.ForeignKeyConstraint(["venue_id"], ["venues.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["point_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["menu_version_id"], ["menu_versions.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("client_event_id"),
    )
    op.create_index("ix_events_point_occurred", "events", ["point_id", "occurred_at"])
    op.create_index("ix_events_venue_occurred", "events", ["venue_id", "occurred_at"])
    op.create_index("ix_events_occurred_at", "events", ["occurred_at"])

    op.create_table(
        "analytics_empty_searches",
        sa.Column("point_id", sa.Uuid(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("query", sa.String(length=100), nullable=False),
        sa.Column("hits", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["point_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("point_id", "day", "query"),
    )
    op.create_table(
        "analytics_daily",
        sa.Column("point_id", sa.Uuid(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("metrics", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["point_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("point_id", "day"),
    )


def downgrade() -> None:
    op.drop_table("analytics_daily")
    op.drop_table("analytics_empty_searches")
    op.drop_index("ix_events_occurred_at", table_name="events")
    op.drop_index("ix_events_venue_occurred", table_name="events")
    op.drop_index("ix_events_point_occurred", table_name="events")
    op.drop_table("events")
