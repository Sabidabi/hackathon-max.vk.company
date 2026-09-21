"""Add authentication and menu domain tables.

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("first_name", sa.String(length=100), server_default="", nullable=False),
    )
    op.add_column("users", sa.Column("last_name", sa.String(length=100), nullable=True))
    op.add_column("users", sa.Column("language_code", sa.String(length=16), nullable=True))
    op.add_column("users", sa.Column("photo_url", sa.String(length=2048), nullable=True))
    op.alter_column("users", "first_name", server_default=None)

    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index(
        "ix_auth_sessions_token_hash", "auth_sessions", ["token_hash"], unique=True
    )
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])

    op.create_table(
        "restaurant_members",
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("role IN ('owner', 'manager', 'editor')", name="ck_member_role"),
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("restaurant_id", "user_id"),
    )

    op.create_table(
        "menus",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column("current_published_version_id", sa.Uuid(), nullable=True),
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
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_menus_restaurant_id", "menus", ["restaurant_id"], unique=True)

    op.create_table(
        "menu_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("menu_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('draft', 'published', 'archived')",
            name="ck_menu_version_status",
        ),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["menu_id"], ["menus.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("menu_id", "version", name="uq_menu_version_number"),
    )
    op.create_foreign_key(
        "fk_menus_current_published_version",
        "menus",
        "menu_versions",
        ["current_published_version_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "menu_sections",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("menu_version_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["menu_version_id"], ["menu_versions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "menu_version_id", "sort_order", name="uq_section_sort_order"
        ),
    )
    op.create_index(
        "ix_menu_sections_menu_version_id",
        "menu_sections",
        ["menu_version_id"],
    )

    op.create_table(
        "menu_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("section_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=250), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("price_minor", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("weight_text", sa.String(length=100), nullable=True),
        sa.Column("ingredients", sa.Text(), nullable=True),
        sa.Column("allergens", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("image_path", sa.String(length=1000), nullable=True),
        sa.Column("is_available", sa.Boolean(), nullable=False),
        sa.Column("source_confidence", sa.Numeric(precision=5, scale=4), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.CheckConstraint("price_minor >= 0", name="ck_item_non_negative_price"),
        sa.CheckConstraint(
            "source_confidence IS NULL OR (source_confidence >= 0 AND source_confidence <= 1)",
            name="ck_item_confidence_range",
        ),
        sa.ForeignKeyConstraint(["section_id"], ["menu_sections.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("section_id", "sort_order", name="uq_item_sort_order"),
    )
    op.create_index("ix_menu_items_section_id", "menu_items", ["section_id"])

    op.create_table(
        "import_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column("original_name", sa.String(length=500), nullable=False),
        sa.Column("stored_path", sa.String(length=1000), nullable=False),
        sa.Column("mime_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=30), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False),
        sa.Column("error_code", sa.String(length=100), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "extracted_payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('uploaded', 'queued', 'extracting', 'ocr', 'structuring', "
            "'needs_review', 'completed', 'failed')",
            name="ck_import_status",
        ),
        sa.CheckConstraint("progress >= 0 AND progress <= 100", name="ck_import_progress"),
        sa.CheckConstraint("size_bytes >= 0", name="ck_import_non_negative_size"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_import_jobs_restaurant_id", "import_jobs", ["restaurant_id"])
    op.create_index("ix_import_jobs_sha256", "import_jobs", ["sha256"])
    op.create_index("ix_import_jobs_status", "import_jobs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_import_jobs_status", table_name="import_jobs")
    op.drop_index("ix_import_jobs_sha256", table_name="import_jobs")
    op.drop_index("ix_import_jobs_restaurant_id", table_name="import_jobs")
    op.drop_table("import_jobs")
    op.drop_index("ix_menu_items_section_id", table_name="menu_items")
    op.drop_table("menu_items")
    op.drop_index("ix_menu_sections_menu_version_id", table_name="menu_sections")
    op.drop_table("menu_sections")
    op.drop_constraint("fk_menus_current_published_version", "menus", type_="foreignkey")
    op.drop_table("menu_versions")
    op.drop_index("ix_menus_restaurant_id", table_name="menus")
    op.drop_table("menus")
    op.drop_table("restaurant_members")
    op.drop_index("ix_auth_sessions_expires_at", table_name="auth_sessions")
    op.drop_index("ix_auth_sessions_token_hash", table_name="auth_sessions")
    op.drop_index("ix_auth_sessions_user_id", table_name="auth_sessions")
    op.drop_table("auth_sessions")
    op.drop_column("users", "photo_url")
    op.drop_column("users", "language_code")
    op.drop_column("users", "last_name")
    op.drop_column("users", "first_name")
