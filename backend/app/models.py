import uuid
from datetime import date, datetime, time
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    Time,
    UniqueConstraint,
    false,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    max_user_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(200))
    first_name: Mapped[str] = mapped_column(String(100), default="")
    last_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    username: Mapped[str | None] = mapped_column(String(100), nullable=True)
    language_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    photo_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    restaurants: Mapped[list["Restaurant"]] = relationship(back_populates="owner")
    sessions: Mapped[list["AuthSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Venue(Base):
    """«Заведение» (brand): owns the points, the menu library and the admin team."""

    __tablename__ = "venues"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200))
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


DEFAULT_TIMEZONE = "Europe/Moscow"


class Restaurant(Base):
    """A point («точка») of a venue: address, hours, time zone, public link and QR."""

    __tablename__ = "restaurants"
    __table_args__ = (UniqueConstraint("id", "venue_id", name="uq_restaurants_id_venue"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    public_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    venue_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), index=True
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    address: Mapped[str | None] = mapped_column(String(500), nullable=True)
    timezone: Mapped[str] = mapped_column(
        String(64), default=DEFAULT_TIMEZONE, server_default=DEFAULT_TIMEZONE
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    owner: Mapped[User] = relationship(back_populates="restaurants")


class RestaurantSite(Base):
    __tablename__ = "restaurant_sites"

    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), primary_key=True
    )
    draft_config: Mapped[dict[str, object]] = mapped_column(JSONB)
    published_config: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    published_version: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    user: Mapped[User] = relationship(back_populates="sessions")


ADMIN_ROLE = "admin"


class VenueMember(Base):
    """Venue-level membership is the only source of management rights: every member is an
    admin of the whole venue (all its points and menus)."""

    __tablename__ = "venue_members"
    __table_args__ = (
        CheckConstraint("role = 'admin'", name="ck_venue_member_role"),
        Index(
            "uq_venue_members_creator",
            "venue_id",
            unique=True,
            postgresql_where=text("is_creator"),
        ),
    )

    venue_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(20), default=ADMIN_ROLE, server_default=ADMIN_ROLE)
    is_creator: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class RestaurantInvite(Base):
    __tablename__ = "restaurant_invites"
    __table_args__ = (
        CheckConstraint("role = 'admin'", name="ck_invite_role"),
        Index("ix_restaurant_invites_created_by_created_at", "created_by_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    # Admin rights are venue-wide; the point is only where the invite was created from.
    venue_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), index=True
    )
    restaurant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), index=True, nullable=True
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    # NULL for link invites that anyone signed in to MAX may accept.
    target_max_user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    role: Mapped[str] = mapped_column(String(20), default=ADMIN_ROLE, server_default=ADMIN_ROLE)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


MENU_SOURCES = ("manual", "iiko")


class Menu(Base):
    """A menu of the venue library; points show it through ``point_menus`` assignments."""

    __tablename__ = "menus"
    __table_args__ = (
        UniqueConstraint("id", "venue_id", name="uq_menus_id_venue"),
        CheckConstraint("source IN ('manual', 'iiko')", name="ck_menu_source"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    venue_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(120))
    source: Mapped[str] = mapped_column(String(16), default="manual", server_default="manual")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    current_published_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "menu_versions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_menus_current_published_version",
        ),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PointMenu(Base):
    """Assignment of a library menu to a point: tab order and optional local show hours.

    The composite foreign keys make the database refuse a menu of another venue.
    """

    __tablename__ = "point_menus"
    __table_args__ = (
        ForeignKeyConstraint(
            ["point_id", "venue_id"],
            ["restaurants.id", "restaurants.venue_id"],
            name="fk_point_menus_point_venue",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["menu_id", "venue_id"],
            ["menus.id", "menus.venue_id"],
            name="fk_point_menus_menu_venue",
            ondelete="CASCADE",
        ),
        UniqueConstraint("point_id", "sort_order", name="uq_point_menus_sort_order"),
        CheckConstraint(
            "(show_from IS NULL) = (show_to IS NULL)", name="ck_point_menus_hours_pair"
        ),
        CheckConstraint(
            "show_from IS NULL OR show_from <> show_to", name="ck_point_menus_hours_span"
        ),
        CheckConstraint("sort_order >= 0", name="ck_point_menus_sort_order"),
        Index("ix_point_menus_menu_id", "menu_id"),
        Index("ix_point_menus_venue_id", "venue_id"),
    )

    point_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    menu_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    venue_id: Mapped[uuid.UUID] = mapped_column()
    sort_order: Mapped[int] = mapped_column(Integer)
    # Local wall-clock hours in the point's time zone; ``show_from > show_to`` spans midnight.
    show_from: Mapped[time | None] = mapped_column(Time(), nullable=True)
    show_to: Mapped[time | None] = mapped_column(Time(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class MenuVersion(Base):
    __tablename__ = "menu_versions"
    __table_args__ = (
        UniqueConstraint("menu_id", "version", name="uq_menu_version_number"),
        CheckConstraint(
            "status IN ('draft', 'published', 'archived')",
            name="ck_menu_version_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    menu_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("menus.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MenuSection(Base):
    __tablename__ = "menu_sections"
    __table_args__ = (
        UniqueConstraint("menu_version_id", "sort_order", name="uq_section_sort_order"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    menu_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("menu_versions.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    sort_order: Mapped[int] = mapped_column(Integer)


class MenuItem(Base):
    __tablename__ = "menu_items"
    __table_args__ = (
        UniqueConstraint("section_id", "sort_order", name="uq_item_sort_order"),
        CheckConstraint("price_minor >= 0", name="ck_item_non_negative_price"),
        CheckConstraint(
            "source_confidence IS NULL OR (source_confidence >= 0 AND source_confidence <= 1)",
            name="ck_item_confidence_range",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    section_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("menu_sections.id", ondelete="CASCADE"), index=True
    )
    # Stable identity of the position across all versions of its menu; the row ``id`` is
    # regenerated on every save. Point stop-lists, prices and external IDs attach to it.
    item_key: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4, index=True)
    name: Mapped[str] = mapped_column(String(250))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    price_minor: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="RUB")
    weight_text: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ingredients: Mapped[str | None] = mapped_column(Text, nullable=True)
    allergens: Mapped[list[str]] = mapped_column(JSONB, default=list)
    configuration: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    image_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    is_available: Mapped[bool] = mapped_column(Boolean, default=True)
    source_confidence: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 4), nullable=True
    )
    sort_order: Mapped[int] = mapped_column(Integer)


class PointItemOverride(Base):
    """Operational layer of one point: stop-list and (optionally) its own price.

    Applied to that point's guests immediately; menu versions are never touched.
    """

    __tablename__ = "point_item_overrides"
    __table_args__ = (
        CheckConstraint(
            "available IS NOT NULL OR price_minor IS NOT NULL OR variant_prices <> '{}'::jsonb",
            name="ck_point_item_overrides_not_empty",
        ),
        CheckConstraint(
            "price_minor IS NULL OR (price_minor >= 0 AND price_minor <= 100000000)",
            name="ck_point_item_overrides_price",
        ),
        CheckConstraint(
            "jsonb_typeof(variant_prices) = 'object'", name="ck_point_item_overrides_variants"
        ),
    )

    point_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), primary_key=True
    )
    item_key: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    available: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    price_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # {variant_id: price_minor} — absolute size prices for this point.
    variant_prices: Mapped[dict[str, int]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


EXTERNAL_PROVIDERS = ("iiko",)
EXTERNAL_ENTITY_TYPES = (
    "venue",
    "point",
    "menu",
    "section",
    "item",
    "variant",
    "modifier_group",
    "modifier_option",
)


class ExternalRef(Base):
    """POS identifiers (iiko) kept apart from internal IDs; groundwork, no sync code yet.

    ``entity_id`` is the venue/point/menu ID, the item's ``item_key`` or a configuration
    UUID (variant, modifier group or option). One external ID belongs to one venue only.
    """

    __tablename__ = "external_refs"
    __table_args__ = (
        CheckConstraint("provider IN ('iiko')", name="ck_external_refs_provider"),
        CheckConstraint(
            "entity_type IN ('venue', 'point', 'menu', 'section', 'item', 'variant', "
            "'modifier_group', 'modifier_option')",
            name="ck_external_refs_entity_type",
        ),
        UniqueConstraint(
            "provider", "entity_type", "external_id", name="uq_external_refs_external_id"
        ),
        UniqueConstraint(
            "provider", "entity_type", "entity_id", name="uq_external_refs_entity"
        ),
        Index("ix_external_refs_entity", "entity_type", "entity_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    provider: Mapped[str] = mapped_column(String(32))
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID] = mapped_column()
    venue_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), index=True
    )
    external_id: Mapped[str] = mapped_column(String(200))
    external_parent_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    external_revision: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class MenuChangeProposal(Base):
    __tablename__ = "menu_change_proposals"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'applied', 'expired')",
            name="ck_menu_change_proposal_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), index=True
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    expected_revision: Mapped[str] = mapped_column(String(64))
    plan: Mapped[dict[str, object]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_revision: Mapped[str | None] = mapped_column(String(64), nullable=True)


class RestaurantFavorite(Base):
    __tablename__ = "restaurant_favorites"

    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    notifications_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class RestaurantVisit(Base):
    """Signed-in user's recently opened venues for the Home screen; at most ten per user."""

    __tablename__ = "restaurant_visits"
    __table_args__ = (
        Index("ix_restaurant_visits_user_last_opened", "user_id", "last_opened_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    last_opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class NotificationCampaign(Base):
    __tablename__ = "notification_campaigns"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('menu_published', 'marketing')",
            name="ck_notification_campaign_kind",
        ),
        CheckConstraint(
            "status IN ('queued', 'sending', 'completed', 'cancelled')",
            name="ck_notification_campaign_status",
        ),
        CheckConstraint(
            "recipient_count >= 0 AND sent_count >= 0 AND failed_count >= 0",
            name="ck_notification_campaign_counts",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), index=True
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT")
    )
    source_menu_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("menu_versions.id", ondelete="SET NULL"), nullable=True
    )
    event_key: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(30), index=True)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    title: Mapped[str] = mapped_column(String(80))
    body: Mapped[str] = mapped_column(String(500))
    recipient_count: Mapped[int] = mapped_column(Integer, default=0)
    sent_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class NotificationDelivery(Base):
    __tablename__ = "notification_deliveries"
    __table_args__ = (
        UniqueConstraint("campaign_id", "user_id", name="uq_notification_recipient"),
        CheckConstraint(
            "status IN ('pending', 'processing', 'sent', 'failed', 'skipped')",
            name="ck_notification_delivery_status",
        ),
        CheckConstraint("attempt_count >= 0", name="ck_notification_delivery_attempts"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("notification_campaigns.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class McpAccessToken(Base):
    __tablename__ = "mcp_access_tokens"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    client_id: Mapped[str] = mapped_column(String(100))
    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    scopes: Mapped[list[str]] = mapped_column(JSONB)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class McpConfirmation(Base):
    __tablename__ = "mcp_confirmations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    proposal_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("menu_change_proposals.id", ondelete="CASCADE"), unique=True, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class McpAuditEvent(Base):
    __tablename__ = "mcp_audit_events"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    access_token_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mcp_access_tokens.id", ondelete="SET NULL"), nullable=True, index=True
    )
    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    request_id: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4, unique=True, index=True)
    tool: Mapped[str] = mapped_column(String(100))
    argument_hash: Mapped[str] = mapped_column(String(64))
    outcome: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ImportJob(Base):
    __tablename__ = "import_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('uploaded', 'queued', 'extracting', 'ocr', 'structuring', "
            "'needs_review', 'completed', 'failed')",
            name="ck_import_status",
        ),
        CheckConstraint("progress >= 0 AND progress <= 100", name="ck_import_progress"),
        CheckConstraint("size_bytes >= 0", name="ck_import_non_negative_size"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), index=True
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT")
    )
    original_name: Mapped[str] = mapped_column(String(500))
    stored_path: Mapped[str] = mapped_column(String(1000))
    mime_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(30), default="uploaded", index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    extracted_payload: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AiUsage(Base):
    """Daily AI request counters (P1-DOC-8 «Лимиты и стоимость»).

    One row per day × venue × feature × subject (``user:<uuid>`` for a signed-in person,
    ``guest:<hash>`` for an anonymous browser, ``worker`` for imports). ``calls`` counts
    accepted requests (limits), ``provider_calls`` real model calls (cost per venue).
    """

    __tablename__ = "ai_usage"
    __table_args__ = (
        CheckConstraint(
            "feature IN ('guest_ask', 'item_description', 'menu_check', 'import_structure', "
            "'menu_plan', 'weekly_summary', 'import_descriptions', 'design_plan')",
            name="ck_ai_usage_feature",
        ),
        CheckConstraint(
            "calls >= 0 AND provider_calls >= 0", name="ck_ai_usage_non_negative"
        ),
        Index("ix_ai_usage_venue_day", "venue_id", "day"),
        Index("ix_ai_usage_subject_day", "subject", "day"),
    )

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    venue_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), primary_key=True
    )
    feature: Mapped[str] = mapped_column(String(32), primary_key=True)
    subject: Mapped[str] = mapped_column(String(80), primary_key=True)
    calls: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    provider_calls: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# --- MAX bot: consent, outbox, subscriptions, demand signals, conversations (0016) ---

GUEST_NOTIFICATION_KINDS = ("g1_back_in_stock", "g2_new_items")
ADMIN_NOTIFICATION_KINDS = (
    "a1_import_ready",
    "a2_admin_joined",
    "a3_menu_published",
    "a4_draft_stale",
    "a5_stop_list_demand",
    "a6_empty_searches",
    "a7_weekly_summary",
    "a8_point_message",
)
CONVERSATION_OUTBOX_KINDS = ("support_forward", "support_reply", "point_reply")
BOT_OUTBOX_KINDS = GUEST_NOTIFICATION_KINDS + ADMIN_NOTIFICATION_KINDS + CONVERSATION_OUTBOX_KINDS


def _in_list(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(value) for value in values)})"


class BotDialog(Base):
    """A MAX user who started a dialog with the bot: the «Разрешить сообщения» step.

    Until a row exists (and while ``stopped_at`` is set) the outbox sends this user nothing:
    it is not verified that a bot may write to someone who only opened the mini-app.
    """

    __tablename__ = "bot_dialogs"
    __table_args__ = (
        CheckConstraint(
            "mode IN ('idle', 'support', 'point_chat', 'admin_reply')", name="ck_bot_dialog_mode"
        ),
    )

    max_user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    chat_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    mode: Mapped[str] = mapped_column(String(20), default="idle", server_default="idle")
    mode_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Conversation(Base):
    """Support ticket (``support``) or a guest's dialog with one point (``point``)."""

    __tablename__ = "conversations"
    __table_args__ = (
        CheckConstraint("kind IN ('support', 'point')", name="ck_conversation_kind"),
        CheckConstraint(
            "status IN ('open', 'answered', 'closed')", name="ck_conversation_status"
        ),
        CheckConstraint(
            "kind = 'support' OR (point_id IS NOT NULL AND venue_id IS NOT NULL)",
            name="ck_conversation_point",
        ),
        CheckConstraint("admin_unread >= 0", name="ck_conversation_unread"),
        Index(
            "uq_conversations_open_support",
            "user_id",
            unique=True,
            postgresql_where=text("kind = 'support' AND status <> 'closed'"),
        ),
        Index(
            "uq_conversations_open_point",
            "user_id",
            "point_id",
            unique=True,
            postgresql_where=text("kind = 'point' AND status <> 'closed'"),
        ),
        Index("ix_conversations_point_last_message", "point_id", "last_message_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    number: Mapped[int] = mapped_column(BigInteger, Identity(), unique=True)
    kind: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="open", server_default="open")
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # Support: «admin» when the requester administers any venue, else «user».
    requester_role: Mapped[str] = mapped_column(String(20), default="user", server_default="user")
    point_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), nullable=True
    )
    venue_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), nullable=True, index=True
    )
    admin_unread: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_message_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ConversationMessage(Base):
    """One message of a conversation. Text and attachments are untrusted user data."""

    __tablename__ = "conversation_messages"
    __table_args__ = (
        CheckConstraint("direction IN ('in', 'out')", name="ck_conversation_message_direction"),
        Index("ix_conversation_messages_conversation_created", "conversation_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE")
    )
    # «in» — from the guest/requester, «out» — answer of the point or the support team.
    direction: Mapped[str] = mapped_column(String(3))
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    body: Mapped[str] = mapped_column(String(4000), default="", server_default="")
    attachments: Mapped[list[dict]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ConversationBlock(Base):
    """A guest blocked by the admins of a venue: their new point messages are refused."""

    __tablename__ = "conversation_blocks"

    venue_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class BotMessageLink(Base):
    """MAX message id of a copy the bot sent (to support or to an admin) → its conversation,
    so a reply to that copy is routed back to the requester."""

    __tablename__ = "bot_message_links"

    max_message_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class BotOutbox(Base):
    """Every bot notification: stored atomically with its event, delivered by the worker with
    retries; ``dedup_key`` makes a repeated event or a repeated check a no-op."""

    __tablename__ = "bot_outbox"
    __table_args__ = (
        CheckConstraint(_in_list("kind", BOT_OUTBOX_KINDS), name="ck_bot_outbox_kind"),
        CheckConstraint(
            "category IN ('marketing', 'service', 'reply')", name="ck_bot_outbox_category"
        ),
        CheckConstraint(
            "status IN ('pending', 'processing', 'sent', 'failed', 'skipped')",
            name="ck_bot_outbox_status",
        ),
        CheckConstraint(
            "(user_id IS NULL) <> (chat_id IS NULL)", name="ck_bot_outbox_recipient"
        ),
        CheckConstraint("attempt_count >= 0", name="ck_bot_outbox_attempts"),
        Index("ix_bot_outbox_status_not_before", "status", "not_before"),
        Index("ix_bot_outbox_user_kind_created", "user_id", "kind", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    dedup_key: Mapped[str] = mapped_column(String(200), unique=True)
    kind: Mapped[str] = mapped_column(String(40))
    category: Mapped[str] = mapped_column(String(20))
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    chat_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    restaurant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), nullable=True, index=True
    )
    venue_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), nullable=True, index=True
    )
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    body: Mapped[str] = mapped_column(String(4000))
    # Rows of buttons: {"type": "open_app"|"callback", "text": ..., "payload": ...}.
    buttons: Mapped[list] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    attachments: Mapped[list] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    payload: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    status: Mapped[str] = mapped_column(String(20), default="pending", server_default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    not_before: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    max_message_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ItemSubscription(Base):
    """«Сообщить, когда появится»: explicit consent for one position at one point."""

    __tablename__ = "item_subscriptions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    point_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    item_key: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    item_name: Mapped[str] = mapped_column(String(250))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AdminNotificationMute(Base):
    """Admin notification types (А1–А8) are on by default; a row switches one type off
    for one admin in one venue."""

    __tablename__ = "admin_notification_mutes"
    __table_args__ = (
        CheckConstraint(
            _in_list("kind", ADMIN_NOTIFICATION_KINDS), name="ck_admin_notification_mute_kind"
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    venue_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("venues.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(40), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class DemandSignalHit(Base):
    """One guest opened a position / searched a phrase with no result at a point on a local
    day. Rows are distinct guests; they feed А5 (demand for the stop-list) and А6 (empty
    searches). Product analytics (E6) is separate.
    """

    __tablename__ = "demand_signal_hits"
    __table_args__ = (
        CheckConstraint("kind IN ('item_open', 'empty_search')", name="ck_demand_signal_kind"),
        Index("ix_demand_signal_hits_point_day", "point_id", "day"),
    )

    point_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), primary_key=True
    )
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), primary_key=True)
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


EVENT_PLATFORMS = ("max_ios", "max_android", "max_web", "web")


class AnalyticsEvent(Base):
    """Append-only product event (P1-DOC-10 «Событийная модель»). ``props`` never carries
    personal data; ``client_event_id`` makes a repeated batch a no-op. Synthetic events exist
    only in the demo venue and are flagged."""

    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint(_in_list("platform", EVENT_PLATFORMS), name="ck_events_platform"),
        Index("ix_events_point_occurred", "point_id", "occurred_at"),
        Index("ix_events_venue_occurred", "venue_id", "occurred_at"),
        Index("ix_events_occurred_at", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    client_event_id: Mapped[uuid.UUID] = mapped_column(unique=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    venue_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("venues.id", ondelete="CASCADE"))
    point_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE")
    )
    menu_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("menu_versions.id", ondelete="SET NULL"), nullable=True
    )
    session_id: Mapped[uuid.UUID] = mapped_column()
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    platform: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(40))
    props: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    is_synthetic: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())


class AnalyticsEmptySearch(Base):
    """«Искали, но не нашли»: the only place a (normalised) search phrase is kept."""

    __tablename__ = "analytics_empty_searches"

    point_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), primary_key=True
    )
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    query: Mapped[str] = mapped_column(String(100), primary_key=True)
    hits: Mapped[int] = mapped_column(Integer, default=0)


class AnalyticsDaily(Base):
    """Daily roll-up of a point's closed local day; kept after raw events expire (180 days)."""

    __tablename__ = "analytics_daily"

    point_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="CASCADE"), primary_key=True
    )
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    metrics: Mapped[dict] = mapped_column(JSONB)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
