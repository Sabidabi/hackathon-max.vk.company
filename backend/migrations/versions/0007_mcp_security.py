# ruff: noqa: E501
"""Add scoped MCP access tokens, confirmations and audit log.

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "mcp_access_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("client_id", sa.String(length=100), nullable=False),
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("scopes", postgresql.JSONB(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_mcp_access_tokens_token_hash", "mcp_access_tokens", ["token_hash"], unique=True)
    op.create_index("ix_mcp_access_tokens_restaurant_id", "mcp_access_tokens", ["restaurant_id"])
    op.create_index("ix_mcp_access_tokens_user_id", "mcp_access_tokens", ["user_id"])
    op.create_index("ix_mcp_access_tokens_expires_at", "mcp_access_tokens", ["expires_at"])
    op.create_table(
        "mcp_confirmations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("proposal_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["proposal_id"], ["menu_change_proposals.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_mcp_confirmations_proposal_id", "mcp_confirmations", ["proposal_id"], unique=True)
    op.create_index("ix_mcp_confirmations_token_hash", "mcp_confirmations", ["token_hash"], unique=True)
    op.create_index("ix_mcp_confirmations_expires_at", "mcp_confirmations", ["expires_at"])
    op.create_table(
        "mcp_audit_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("access_token_id", sa.Uuid(), nullable=True),
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("tool", sa.String(length=100), nullable=False),
        sa.Column("argument_hash", sa.String(length=64), nullable=False),
        sa.Column("outcome", sa.String(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["access_token_id"], ["mcp_access_tokens.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_mcp_audit_events_access_token_id", "mcp_audit_events", ["access_token_id"])
    op.create_index("ix_mcp_audit_events_restaurant_id", "mcp_audit_events", ["restaurant_id"])
    op.create_index("ix_mcp_audit_events_user_id", "mcp_audit_events", ["user_id"])
    op.create_index("ix_mcp_audit_events_request_id", "mcp_audit_events", ["request_id"], unique=True)


def downgrade():
    op.drop_index("ix_mcp_audit_events_request_id", table_name="mcp_audit_events")
    op.drop_index("ix_mcp_audit_events_user_id", table_name="mcp_audit_events")
    op.drop_index("ix_mcp_audit_events_restaurant_id", table_name="mcp_audit_events")
    op.drop_index("ix_mcp_audit_events_access_token_id", table_name="mcp_audit_events")
    op.drop_table("mcp_audit_events")
    op.drop_index("ix_mcp_confirmations_expires_at", table_name="mcp_confirmations")
    op.drop_index("ix_mcp_confirmations_token_hash", table_name="mcp_confirmations")
    op.drop_index("ix_mcp_confirmations_proposal_id", table_name="mcp_confirmations")
    op.drop_table("mcp_confirmations")
    op.drop_index("ix_mcp_access_tokens_expires_at", table_name="mcp_access_tokens")
    op.drop_index("ix_mcp_access_tokens_user_id", table_name="mcp_access_tokens")
    op.drop_index("ix_mcp_access_tokens_restaurant_id", table_name="mcp_access_tokens")
    op.drop_index("ix_mcp_access_tokens_token_hash", table_name="mcp_access_tokens")
    op.drop_table("mcp_access_tokens")
