"""Allow the weekly AI summary feature in ai_usage.

Revision ID: 0019
Revises: 0018
"""

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None

OLD = "feature IN ('guest_ask', 'item_description', 'menu_check', 'import_structure', 'menu_plan')"
NEW = (
    "feature IN ('guest_ask', 'item_description', 'menu_check', 'import_structure', "
    "'menu_plan', 'weekly_summary')"
)


def upgrade() -> None:
    op.drop_constraint("ck_ai_usage_feature", "ai_usage", type_="check")
    op.create_check_constraint("ck_ai_usage_feature", "ai_usage", NEW)


def downgrade() -> None:
    op.execute("DELETE FROM ai_usage WHERE feature = 'weekly_summary'")
    op.drop_constraint("ck_ai_usage_feature", "ai_usage", type_="check")
    op.create_check_constraint("ck_ai_usage_feature", "ai_usage", OLD)
