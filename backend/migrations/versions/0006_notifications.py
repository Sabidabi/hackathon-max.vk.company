# ruff: noqa: E501
"""Add favorites and rate-limited MAX notification outbox.

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "restaurant_favorites",
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("notifications_enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("restaurant_id", "user_id"),
    )
    op.create_table(
        "notification_campaigns",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column("source_menu_version_id", sa.Uuid(), nullable=True),
        sa.Column("event_key", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=30), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=80), nullable=False),
        sa.Column("body", sa.String(length=500), nullable=False),
        sa.Column("recipient_count", sa.Integer(), nullable=False),
        sa.Column("sent_count", sa.Integer(), nullable=False),
        sa.Column("failed_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('menu_published', 'marketing')", name="ck_notification_campaign_kind"),
        sa.CheckConstraint("status IN ('queued', 'sending', 'completed', 'cancelled')", name="ck_notification_campaign_status"),
        sa.CheckConstraint("recipient_count >= 0 AND sent_count >= 0 AND failed_count >= 0", name="ck_notification_campaign_counts"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_menu_version_id"], ["menu_versions.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_notification_campaigns_restaurant_id", "notification_campaigns", ["restaurant_id"])
    op.create_index("ix_notification_campaigns_event_key", "notification_campaigns", ["event_key"], unique=True)
    op.create_index("ix_notification_campaigns_kind", "notification_campaigns", ["kind"])
    op.create_index("ix_notification_campaigns_status", "notification_campaigns", ["status"])
    op.create_table(
        "notification_deliveries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("campaign_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("error_code", sa.String(length=100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('pending', 'processing', 'sent', 'failed', 'skipped')", name="ck_notification_delivery_status"),
        sa.CheckConstraint("attempt_count >= 0", name="ck_notification_delivery_attempts"),
        sa.ForeignKeyConstraint(["campaign_id"], ["notification_campaigns.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("campaign_id", "user_id", name="uq_notification_recipient"),
    )
    op.create_index("ix_notification_deliveries_campaign_id", "notification_deliveries", ["campaign_id"])
    op.create_index("ix_notification_deliveries_user_id", "notification_deliveries", ["user_id"])
    op.create_index("ix_notification_deliveries_status", "notification_deliveries", ["status"])


def downgrade():
    op.drop_index("ix_notification_deliveries_status", table_name="notification_deliveries")
    op.drop_index("ix_notification_deliveries_user_id", table_name="notification_deliveries")
    op.drop_index("ix_notification_deliveries_campaign_id", table_name="notification_deliveries")
    op.drop_table("notification_deliveries")
    op.drop_index("ix_notification_campaigns_status", table_name="notification_campaigns")
    op.drop_index("ix_notification_campaigns_kind", table_name="notification_campaigns")
    op.drop_index("ix_notification_campaigns_event_key", table_name="notification_campaigns")
    op.drop_index("ix_notification_campaigns_restaurant_id", table_name="notification_campaigns")
    op.drop_table("notification_campaigns")
    op.drop_table("restaurant_favorites")
