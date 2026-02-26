# Multi-Device KOReader Sync

## Context

KOReader sync currently only supports Kobo. Adding Android (Pixel) as a second device introduces two problems: (1) different devices may store the same book under different filenames, breaking the single `koreader_filename` column lookup, and (2) cross-device reading wants a Kindle-style "continue from X%?" prompt when opening a book that was read further on another device.

The Pixel workflow is identical to Kobo: browse OPDS catalog in KOReader, download books, read, auto-sync progress back to server. The server doesn't need to track which device is syncing -- it just stores the latest state. The device decides locally whether to prompt.

## Design principles

- **Server is dumb:** always accept pushes (last-write-wins by timestamp, as today). No device tracking.
- **Device is smart:** on pull, compare server progress vs local. If server is ahead, prompt. If behind, ignore.
- **Hash-based matching:** EPUB MD5 hash is the primary cross-device identifier. Same file content = same book, regardless of filename or directory structure. The existing `koreader_filename` column stays as a fast secondary lookup and gets set on any match.
- **Transient data ages off:** filename mappings and sync timestamps expire after 90 days. Re-established on next sync if needed.

## Changes

### 1. Database: epub_hash column (done)

**File:** `books/helpers/db.py`

Add `epub_hash` (TEXT) column to `books` table with `(user_id, epub_hash)` index.

**Migration** (`_migrate_epub_hash()`):

- Add column + index
- Backfill: compute MD5 of every existing EPUB file in `$BOOKS_DATA_DIR/files/{user_id}/`

**New db function:**

- `get_book_by_epub_hash(user_id, epub_hash)` -- indexed lookup, returns book dict or None

**Upload path** (`books/routes/books.py`):

- Compute MD5 on EPUB upload, store in `epub_hash` column

### 2. Backend: hash-first resolution cascade (done)

**File:** `books/routes/kobo.py`

`epub_hash` added to `SyncBookIn` and `SyncBookOut` models (optional field).

**`_resolve_book()` resolution cascade:**

1. `db.get_book_by_epub_hash(user_id, epub_hash)` -- fastest, content-based, works across renames
2. `db.get_book_by_koreader_filename(user_id, filename)` -- cached from previous matches
3. Fuzzy match (normalized title + author token overlap)
4. On any match, call `db.set_koreader_filename()` to cache the current filename

**New endpoint:** `GET /api/kobo/ping` -- health check that validates auth, returns `{"status": "ok", "username": "..."}`.

**`_sync_book()` -- no changes to logic.** Last-write-wins by timestamp continues to work. Server always returns its current state (including `epub_hash`). The device handles the UX.

### 3. Plugin: Android support + Kindle-style prompt (done)

**File:** `koreader/plugins/booksync.koplugin/main.lua`

**3a. Configurable books directory (done):**

- `getBooksDir()` method with resolution: user setting > `Device.home_dir` > `"."`
- KOReader's `Device.home_dir` is platform-aware: `/mnt/onboard` on Kobo, `/storage/emulated/0` on Android, etc.
- User override via menu item (InputDialog, shows current path)
- `buildFilepathMap()` uses `self:getBooksDir()`

**3b. EPUB hash for cross-device matching (done):**

- `readBookState()` computes MD5 hash of the EPUB file via `ffi/md5`
- Hash is cached in the sidecar data so it's only computed once per book
- Sent as `epub_hash` in sync request; server uses it as primary match key

**3c. Kindle-style "continue from" prompt (done):**

`offerJumpAhead()` fires after sync when a book is open. If server progress exceeds local progress by >0.1%, shows a ConfirmBox offering to jump. Uses `GotoPercentage` event.

**3d. Other improvements (done):**

- `httpGet()` method for ping endpoint
- Connection test uses `/api/kobo/ping` instead of empty sync POST
- `sync_in_progress` guard prevents concurrent syncs
- `last_sync_fail_time` debounce skips sync on disconnect if server just failed
- `applyServerState()` handles float epsilon, type guards, synthetic "reading" status
- Tighter HTTP timeouts (5s connect, 10s total)
- Better toast messages (show unmatched count)

**3e. No changes needed for always-on phone.** Sync is event-driven (page turns, book open/close, suspend). A backgrounded KOReader generates no events.

### 4. Stale data cleanup (not yet done)

**File:** `books/helpers/db.py`

`cleanup_stale_sync_data()`:

- Clear `progress` and `sync_updated_at` on books where `sync_updated_at` < 90 days ago and `reading_status = 'reading'` (stale in-progress books -- completed books keep their state)
- Called from `init_db()` (runs once per server start, cheap query)

Note: the `koreader_filenames` table from the original design was not needed. The `epub_hash` approach makes filename mapping a secondary concern -- the existing single `koreader_filename` column is sufficient as a cache since hash matching handles the cross-device case.

### 5. Always-on phone concern

Not a real problem -- confirmed by reviewing sync triggers:

- `onNetworkConnected`: fires once at KOReader start (WiFi always on) -- just a sync-all, fine
- `onPageUpdate`: only fires during active reading
- `onSuspend`: fires once when app backgrounds
- No timer/polling

## Implementation status

- [x] `books/helpers/db.py` -- `epub_hash` column, migration, backfill (1113 books), lookup function
- [x] `books/routes/books.py` -- hash on upload
- [x] `books/routes/kobo.py` -- hash-first resolution, ping endpoint, hash in models
- [x] `koreader/plugins/booksync.koplugin/main.lua` -- hash computation, books dir, prompt, robustness
- [x] Backend deployed, migration verified
- [x] Plugin deployed to Kobo, sync verified working (2026-02-25)
- [ ] `books/helpers/db.py` -- stale data cleanup
- [ ] Install KOReader on Pixel, copy plugin, test cross-device sync

## Next step: Android (Pixel 9a)

1. Install KOReader on the Pixel from F-Droid or GitHub releases
2. Copy the booksync plugin to the KOReader plugins directory on the phone
3. Configure server settings (URL, username, password) via Book Sync menu
4. Set books directory if needed (will default to `Device.home_dir` which is `/storage/emulated/0` on Android)
5. Add OPDS catalog (server URL + `/api/opds/`) to download a book
6. Read a few pages, verify sync pushes to server
7. Open the same book on Kobo, verify the "jump ahead" prompt appears

## Verification log

- 2026-02-25: Backend deployed. Migration backfilled `epub_hash` for 1113 books.
- 2026-02-25: Plugin deployed to Kobo. Sync verified -- books syncing with hashes and updated timestamps in DB.
