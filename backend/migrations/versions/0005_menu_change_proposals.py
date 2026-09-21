"""Add reviewable AI and MCP menu change proposals.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "menu_change_proposals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column("expected_revision", sa.String(length=64), nullable=False),
        sa.Column("plan", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result_revision", sa.String(length=64), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'applied', 'expired')",
            name="ck_menu_change_proposal_status",
        ),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_menu_change_proposals_restaurant_id",
        "menu_change_proposals",
        ["restaurant_id"],
    )
    op.create_index(
        "ix_menu_change_proposals_created_by_id",
        "menu_change_proposals",
        ["created_by_id"],
    )
    op.create_index(
        "ix_menu_change_proposals_status",
        "menu_change_proposals",
        ["status"],
    )
    op.create_index(
        "ix_menu_change_proposals_expires_at",
        "menu_change_proposals",
        ["expires_at"],
    )


def downgrade():
    op.drop_index("ix_menu_change_proposals_expires_at", table_name="menu_change_proposals")
    op.drop_index("ix_menu_change_proposals_status", table_name="menu_change_proposals")
    op.drop_index("ix_menu_change_proposals_created_by_id", table_name="menu_change_proposals")
    op.drop_index("ix_menu_change_proposals_restaurant_id", table_name="menu_change_proposals")
    op.drop_table("menu_change_proposals")
