"""Point operational layer (stop-list, own price) and POS external IDs groundwork.

``point_item_overrides`` keys a point's stop-list and optional price by the stable
``item_key``; it applies to guests at once, without publishing a menu version.

``external_refs`` stores identifiers of an external POS (iiko, P1-DOC-16) apart from
internal IDs. ``UNIQUE (provider, entity_type, external_id)`` is stricter than the
per-venue tuple of the spec and thereby guarantees that one external ID is never linked
to entities of two venues. The table is created empty; there is no integration code.

Revision ID: 0014
Revises: 0013
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "point_item_overrides",
        sa.Column("point_id", sa.Uuid(), nullable=False),
        sa.Column("item_key", sa.Uuid(), nullable=False),
        sa.Column("available", sa.Boolean(), nullable=True),
        sa.Column("price_minor", sa.Integer(), nullable=True),
        sa.Column(
            "variant_prices", postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"), nullable=False,
        ),
        sa.Column("updated_by_id", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "available IS NOT NULL OR price_minor IS NOT NULL OR variant_prices <> '{}'::jsonb",
            name="ck_point_item_overrides_not_empty",
        ),
        sa.CheckConstraint(
            "price_minor IS NULL OR (price_minor >= 0 AND price_minor <= 100000000)",
            name="ck_point_item_overrides_price",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(variant_prices) = 'object'", name="ck_point_item_overrides_variants"
        ),
        sa.ForeignKeyConstraint(["point_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("point_id", "item_key"),
    )
    op.create_index(
        "ix_point_item_overrides_updated_by_id", "point_item_overrides", ["updated_by_id"]
    )

    op.create_table(
        "external_refs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("venue_id", sa.Uuid(), nullable=False),
        sa.Column("external_id", sa.String(length=200), nullable=False),
        sa.Column("external_parent_id", sa.String(length=200), nullable=True),
        sa.Column("external_revision", sa.BigInteger(), nullable=True),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("provider IN ('iiko')", name="ck_external_refs_provider"),
        sa.CheckConstraint(
            "entity_type IN ('venue', 'point', 'menu', 'section', 'item', 'variant', "
            "'modifier_group', 'modifier_option')",
            name="ck_external_refs_entity_type",
        ),
        sa.ForeignKeyConstraint(["venue_id"], ["venues.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider", "entity_type", "external_id", name="uq_external_refs_external_id"
        ),
        sa.UniqueConstraint(
            "provider", "entity_type", "entity_id", name="uq_external_refs_entity"
        ),
    )
    op.create_index("ix_external_refs_entity", "external_refs", ["entity_type", "entity_id"])
    op.create_index("ix_external_refs_venue_id", "external_refs", ["venue_id"])


def downgrade() -> None:
    op.drop_index("ix_external_refs_venue_id", table_name="external_refs")
    op.drop_index("ix_external_refs_entity", table_name="external_refs")
    op.drop_table("external_refs")
    op.drop_index("ix_point_item_overrides_updated_by_id", table_name="point_item_overrides")
    op.drop_table("point_item_overrides")
