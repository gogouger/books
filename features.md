# Feature Plans

## Series

- [x] Monthly auto-refresh of series metadata (1/min rate limit, daily check cycle)

## UI polish

- [ ] List vs thumbnail view toggle
- [ ] Sidebar with #A-Z for quick letter selection (or numbers if sorting by rating)
- [x] Read-only users: filter out placeholders by default (show only owned/rated books
  in library view; placeholders still visible in series view). Maybe a toggle for
  owned/unowned that defaults to owned/rated.
- [ ] Superuser cross-library book adding (copy button doesn't work from within your
  own library)

## Bigger features

- [ ] Multiple kindle email addresses as send-to targets (e.g. send to both me and
  ada's accounts from my library)

## KOReader integration

- [x] Lua script for KOReader on Kobo
- [x] POST reading progress: pages read, currently reading status
- [x] Read completion triggers status change
- [x] Rating/ranking prompt on finish
- [x] Token-based device auth (separate from Google OAuth)
