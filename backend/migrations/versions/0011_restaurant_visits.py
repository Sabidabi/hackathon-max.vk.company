"""Recently opened venues per signed-in user for the Home screen.

Revision ID: 0011
Revises: 0010
"""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "restaurant_visits",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("restaurant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "last_opened_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["restaurant_id"], ["restaurants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "restaurant_id"),
    )
    op.create_index(
        "ix_restaurant_visits_user_last_opened",
        "restaurant_visits",
        ["user_id", "last_opened_at"],
    )
    op.create_index(
        "ix_restaurant_visits_restaurant_id", "restaurant_visits", ["restaurant_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_restaurant_visits_restaurant_id", table_name="restaurant_visits")
    op.drop_index("ix_restaurant_visits_user_last_opened", table_name="restaurant_visits")
    op.drop_table("restaurant_visits")
