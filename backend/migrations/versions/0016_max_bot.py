# ruff: noqa: E501
"""MAX bot (P1-PLAN-13): dialog consent, bot outbox, item subscriptions, admin notification
settings, demand signals, support tickets and guest-to-point conversations.

Number 0016 is reserved for the bot branch (0015 is left to the cloud session); on merge
after a 0015 the chain becomes 0015 -> 0016. Nothing here touches existing tables.

Revision ID: 0016
Revises: 0014
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0016"
down_revision: str | Sequence[str] | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('admin_notification_mutes',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('venue_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("kind IN ('a1_import_ready', 'a2_admin_joined', 'a3_menu_published', 'a4_draft_stale', 'a5_stop_list_demand', 'a6_empty_searches', 'a7_weekly_summary', 'a8_point_message')", name='ck_admin_notification_mute_kind'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['venue_id'], ['venues.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'venue_id', 'kind')
    )
    op.create_table('conversation_blocks',
    sa.Column('venue_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('created_by_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['venue_id'], ['venues.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('venue_id', 'user_id')
    )
    op.create_table('conversations',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('number', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('status', sa.String(length=20), server_default='open', nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('requester_role', sa.String(length=20), server_default='user', nullable=False),
    sa.Column('point_id', sa.Uuid(), nullable=True),
    sa.Column('venue_id', sa.Uuid(), nullable=True),
    sa.Column('admin_unread', sa.Integer(), server_default='0', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_message_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("kind = 'support' OR (point_id IS NOT NULL AND venue_id IS NOT NULL)", name='ck_conversation_point'),
    sa.CheckConstraint("kind IN ('support', 'point')", name='ck_conversation_kind'),
    sa.CheckConstraint("status IN ('open', 'answered', 'closed')", name='ck_conversation_status'),
    sa.CheckConstraint('admin_unread >= 0', name='ck_conversation_unread'),
    sa.ForeignKeyConstraint(['point_id'], ['restaurants.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['venue_id'], ['venues.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('number')
    )
    op.create_index('ix_conversations_point_last_message', 'conversations', ['point_id', 'last_message_at'], unique=False)
    op.create_index(op.f('ix_conversations_user_id'), 'conversations', ['user_id'], unique=False)
    op.create_index(op.f('ix_conversations_venue_id'), 'conversations', ['venue_id'], unique=False)
    op.create_index('uq_conversations_open_point', 'conversations', ['user_id', 'point_id'], unique=True, postgresql_where=sa.text("kind = 'point' AND status <> 'closed'"))
    op.create_index('uq_conversations_open_support', 'conversations', ['user_id'], unique=True, postgresql_where=sa.text("kind = 'support' AND status <> 'closed'"))
    op.create_table('demand_signal_hits',
    sa.Column('point_id', sa.Uuid(), nullable=False),
    sa.Column('day', sa.Date(), nullable=False),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('key', sa.String(length=200), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("kind IN ('item_open', 'empty_search')", name='ck_demand_signal_kind'),
    sa.ForeignKeyConstraint(['point_id'], ['restaurants.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('point_id', 'day', 'kind', 'key', 'user_id')
    )
    op.create_index('ix_demand_signal_hits_point_day', 'demand_signal_hits', ['point_id', 'day'], unique=False)
    op.create_table('item_subscriptions',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('point_id', sa.Uuid(), nullable=False),
    sa.Column('item_key', sa.Uuid(), nullable=False),
    sa.Column('item_name', sa.String(length=250), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['point_id'], ['restaurants.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'point_id', 'item_key')
    )
    op.create_index(op.f('ix_item_subscriptions_point_id'), 'item_subscriptions', ['point_id'], unique=False)
    op.create_table('bot_dialogs',
    sa.Column('max_user_id', sa.BigInteger(), autoincrement=False, nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('chat_id', sa.BigInteger(), nullable=True),
    sa.Column('mode', sa.String(length=20), server_default='idle', nullable=False),
    sa.Column('mode_conversation_id', sa.Uuid(), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('stopped_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("mode IN ('idle', 'support', 'point_chat', 'admin_reply')", name='ck_bot_dialog_mode'),
    sa.ForeignKeyConstraint(['mode_conversation_id'], ['conversations.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('max_user_id')
    )
    op.create_index(op.f('ix_bot_dialogs_user_id'), 'bot_dialogs', ['user_id'], unique=False)
    op.create_table('bot_message_links',
    sa.Column('max_message_id', sa.String(length=100), nullable=False),
    sa.Column('conversation_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('max_message_id')
    )
    op.create_index(op.f('ix_bot_message_links_conversation_id'), 'bot_message_links', ['conversation_id'], unique=False)
    op.create_table('bot_outbox',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('dedup_key', sa.String(length=200), nullable=False),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('category', sa.String(length=20), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('chat_id', sa.BigInteger(), nullable=True),
    sa.Column('restaurant_id', sa.Uuid(), nullable=True),
    sa.Column('venue_id', sa.Uuid(), nullable=True),
    sa.Column('conversation_id', sa.Uuid(), nullable=True),
    sa.Column('body', sa.String(length=4000), nullable=False),
    sa.Column('buttons', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
    sa.Column('attachments', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('status', sa.String(length=20), server_default='pending', nullable=False),
    sa.Column('attempt_count', sa.Integer(), server_default='0', nullable=False),
    sa.Column('not_before', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('error_code', sa.String(length=100), nullable=True),
    sa.Column('max_message_id', sa.String(length=100), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("category IN ('marketing', 'service', 'reply')", name='ck_bot_outbox_category'),
    sa.CheckConstraint("kind IN ('g1_back_in_stock', 'g2_new_items', 'a1_import_ready', 'a2_admin_joined', 'a3_menu_published', 'a4_draft_stale', 'a5_stop_list_demand', 'a6_empty_searches', 'a7_weekly_summary', 'a8_point_message', 'support_forward', 'support_reply', 'point_reply')", name='ck_bot_outbox_kind'),
    sa.CheckConstraint("status IN ('pending', 'processing', 'sent', 'failed', 'skipped')", name='ck_bot_outbox_status'),
    sa.CheckConstraint('(user_id IS NULL) <> (chat_id IS NULL)', name='ck_bot_outbox_recipient'),
    sa.CheckConstraint('attempt_count >= 0', name='ck_bot_outbox_attempts'),
    sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['restaurant_id'], ['restaurants.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['venue_id'], ['venues.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('dedup_key')
    )
    op.create_index(op.f('ix_bot_outbox_conversation_id'), 'bot_outbox', ['conversation_id'], unique=False)
    op.create_index(op.f('ix_bot_outbox_restaurant_id'), 'bot_outbox', ['restaurant_id'], unique=False)
    op.create_index('ix_bot_outbox_status_not_before', 'bot_outbox', ['status', 'not_before'], unique=False)
    op.create_index('ix_bot_outbox_user_kind_created', 'bot_outbox', ['user_id', 'kind', 'created_at'], unique=False)
    op.create_index(op.f('ix_bot_outbox_venue_id'), 'bot_outbox', ['venue_id'], unique=False)
    op.create_table('conversation_messages',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('conversation_id', sa.Uuid(), nullable=False),
    sa.Column('direction', sa.String(length=3), nullable=False),
    sa.Column('author_user_id', sa.Uuid(), nullable=True),
    sa.Column('body', sa.String(length=4000), server_default='', nullable=False),
    sa.Column('attachments', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("direction IN ('in', 'out')", name='ck_conversation_message_direction'),
    sa.ForeignKeyConstraint(['author_user_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_conversation_messages_conversation_created', 'conversation_messages', ['conversation_id', 'created_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_conversation_messages_conversation_created', table_name='conversation_messages')
    op.drop_table('conversation_messages')
    op.drop_index(op.f('ix_bot_outbox_venue_id'), table_name='bot_outbox')
    op.drop_index('ix_bot_outbox_user_kind_created', table_name='bot_outbox')
    op.drop_index('ix_bot_outbox_status_not_before', table_name='bot_outbox')
    op.drop_index(op.f('ix_bot_outbox_restaurant_id'), table_name='bot_outbox')
    op.drop_index(op.f('ix_bot_outbox_conversation_id'), table_name='bot_outbox')
    op.drop_table('bot_outbox')
    op.drop_index(op.f('ix_bot_message_links_conversation_id'), table_name='bot_message_links')
    op.drop_table('bot_message_links')
    op.drop_index(op.f('ix_bot_dialogs_user_id'), table_name='bot_dialogs')
    op.drop_table('bot_dialogs')
    op.drop_index(op.f('ix_item_subscriptions_point_id'), table_name='item_subscriptions')
    op.drop_table('item_subscriptions')
    op.drop_index('ix_demand_signal_hits_point_day', table_name='demand_signal_hits')
    op.drop_table('demand_signal_hits')
    op.drop_index('uq_conversations_open_support', table_name='conversations', postgresql_where=sa.text("kind = 'support' AND status <> 'closed'"))
    op.drop_index('uq_conversations_open_point', table_name='conversations', postgresql_where=sa.text("kind = 'point' AND status <> 'closed'"))
    op.drop_index(op.f('ix_conversations_venue_id'), table_name='conversations')
    op.drop_index(op.f('ix_conversations_user_id'), table_name='conversations')
    op.drop_index('ix_conversations_point_last_message', table_name='conversations')
    op.drop_table('conversations')
    op.drop_table('conversation_blocks')
    op.drop_table('admin_notification_mutes')
