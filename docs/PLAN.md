# MAX Menu implementation plan

## 1. Foundation

- [x] React, TypeScript and Vite frontend.
- [x] MAX UI provider and MAX Bridge adapter.
- [x] FastAPI application with structured configuration and logging.
- [x] PostgreSQL connection through SQLAlchemy.
- [x] Alembic migration infrastructure.
- [x] Separate Python worker container.
- [x] Persistent server-side file volume mounted at `/data`.
- [x] Docker Compose startup and health checks.
- [x] Run the complete stack and verify all health checks.

Acceptance criteria:

- `docker compose up --build` starts all four services;
- frontend is available at port `8080`;
- backend liveness and readiness endpoints return HTTP 200;
- migrations are applied automatically;
- recreating `backend` does not remove PostgreSQL or `/data` contents.

## 2. Domain model and authorization

- [x] Complete restaurant, member, menu, version, section and item tables.
- [x] Add import-job state machine.
- [x] Validate signed MAX `initData` on the backend.
- [x] Create or update the local user after MAX authentication.
- [x] Issue a short-lived secure application session.
- [x] Add owner and manager authorization checks.

## 3. MAX integration

- [x] Add the bot webhook endpoint.
- [x] Validate `X-Max-Bot-Api-Secret`.
- [x] Handle bot start and menu-opening actions.
- [x] Support restaurant deep links through `startapp`.
- [x] Send import-complete and import-failed notifications.

## 4. Restaurant cabinet

- [x] Create and edit one restaurant per owner for the MVP.
- [x] Upload a logo and edit public restaurant details.
- [x] Show draft, published version and last import status.
- [x] Generate the public MAX deep link.
- [ ] Generate a QR code.

## 5. Local file upload and storage

- [x] Accept PDF, JPG, JPEG and PNG.
- [x] Enforce size, page-count, MIME and file-signature limits.
- [x] Store files under `/data/uploads/<restaurant>/<import>`.
- [x] Store only relative paths and hashes in PostgreSQL.
- [ ] Add safe cleanup for abandoned imports.
- [ ] Document backup and restore for the PostgreSQL and file volumes.

## 6. PDF/OCR worker

- [x] Claim jobs atomically from PostgreSQL.
- [x] Extract embedded PDF text first.
- [x] Render and OCR pages when embedded text is insufficient.
- [x] Convert extracted content into a validated menu schema.
- [x] Record confidence and source information for fields.
- [ ] Retry transient failures and expose actionable error states.
- [x] Keep a manual menu builder as the fallback path.

## 7. Menu editor

- [x] Review an imported menu and apply it to the current draft.
- [x] Create, rename, reorder and delete sections.
- [x] Create, edit, reorder and delete menu items.
- [ ] Review low-confidence imported fields.
- [x] Autosave the draft.
- [x] Add image upload.
- [x] Add availability controls.
- [x] Keep ingredients and allergens source-based; never invent them.

## 8. Publication and guest menu

- [x] Validate and publish an immutable menu version.
- [x] Preserve the previously published menu while a draft is edited.
- [x] Build the guest category and item views.
- [x] Add search and availability filters.
- [ ] Add an allergen filter.
- [x] Add a fast stop-list action for the restaurant owner.

## 9. Restaurant site builder

- [x] Store separate draft and published site configurations.
- [x] Add modern, classic and cafe templates.
- [x] Customize the primary and background colours.
- [x] Edit the cover, about, phone, hours and booking content.
- [x] Reorder and hide public-page blocks.
- [x] Show a live mobile preview.
- [x] Publish site changes without exposing the draft.
- [x] Upload a site logo, cover and gallery images to local persistent storage.
- [ ] Add custom domains.

## 10. Quality and delivery

- [x] Backend unit and API tests.
- [x] Worker fixtures for text and scanned PDFs.
- [ ] Worker fixtures for empty and damaged PDFs.
- [ ] Frontend component and user-flow tests.
- [ ] Mobile MAX and web MAX smoke tests.
- [ ] HTTPS deployment instructions.
- [x] Add an idempotent demo dataset command and document the reproducible local flow.
- [ ] Technical presentation.

## Explicitly outside the first MVP

- restaurant marketplace and discovery;
- orders, payments and delivery;
- reservations and reviews;
- loyalty programme;
- iiko/R-Keeper integrations;
- multi-server storage and S3.
