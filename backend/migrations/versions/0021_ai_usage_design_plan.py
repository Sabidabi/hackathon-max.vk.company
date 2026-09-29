"""Allow the design plan AI feature in ai_usage.

Revision ID: 0021
Revises: 0020
"""

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None

OLD = (
    "feature IN ('guest_ask', 'item_description', 'menu_check', 'import_structure', "
    "'menu_plan', 'weekly_summary', 'import_descriptions')"
)
NEW = (
    "feature IN ('guest_ask', 'item_description', 'menu_check', 'import_structure', "
    "'menu_plan', 'weekly_summary', 'import_descriptions', 'design_plan')"
)


def upgrade() -> None:
    op.drop_constraint("ck_ai_usage_feature", "ai_usage", type_="check")
    op.create_check_constraint("ck_ai_usage_feature", "ai_usage", NEW)


def downgrade() -> None:
    op.execute("DELETE FROM ai_usage WHERE feature = 'design_plan'")
    op.drop_constraint("ck_ai_usage_feature", "ai_usage", type_="check")
    op.create_check_constraint("ck_ai_usage_feature", "ai_usage", OLD)
