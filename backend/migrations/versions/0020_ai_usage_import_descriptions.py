"""Allow the import descriptions AI feature in ai_usage.

Revision ID: 0020
Revises: 0019
"""

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None

OLD = (
    "feature IN ('guest_ask', 'item_description', 'menu_check', 'import_structure', "
    "'menu_plan', 'weekly_summary')"
)
NEW = (
    "feature IN ('guest_ask', 'item_description', 'menu_check', 'import_structure', "
    "'menu_plan', 'weekly_summary', 'import_descriptions')"
)


def upgrade() -> None:
    op.drop_constraint("ck_ai_usage_feature", "ai_usage", type_="check")
    op.create_check_constraint("ck_ai_usage_feature", "ai_usage", NEW)


def downgrade() -> None:
    op.execute("DELETE FROM ai_usage WHERE feature = 'import_descriptions'")
    op.drop_constraint("ck_ai_usage_feature", "ai_usage", type_="check")
    op.create_check_constraint("ck_ai_usage_feature", "ai_usage", OLD)
