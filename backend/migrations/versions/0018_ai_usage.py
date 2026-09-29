"""Daily AI request counters per venue, feature and subject (P1-DOC-8 «Лимиты»).

Revision ID: 0018
Revises: 0017
"""

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_usage",
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("venue_id", sa.Uuid(), nullable=False),
        sa.Column("feature", sa.String(length=32), nullable=False),
        sa.Column("subject", sa.String(length=80), nullable=False),
        sa.Column("calls", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("provider_calls", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "feature IN ('guest_ask', 'item_description', 'menu_check', 'import_structure', "
            "'menu_plan')",
            name="ck_ai_usage_feature",
        ),
        sa.CheckConstraint(
            "calls >= 0 AND provider_calls >= 0", name="ck_ai_usage_non_negative"
        ),
        sa.ForeignKeyConstraint(["venue_id"], ["venues.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("day", "venue_id", "feature", "subject"),
    )
    op.create_index("ix_ai_usage_venue_day", "ai_usage", ["venue_id", "day"])
    op.create_index("ix_ai_usage_subject_day", "ai_usage", ["subject", "day"])


def downgrade() -> None:
    op.drop_index("ix_ai_usage_subject_day", table_name="ai_usage")
    op.drop_index("ix_ai_usage_venue_day", table_name="ai_usage")
    op.drop_table("ai_usage")
