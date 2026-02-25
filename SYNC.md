# Multi-Device KOReader Sync

## Context

KOReader sync currently only supports Kobo. Adding Android (Pixel) as a second device introduces two problems: (1) different devices may store the same book under different filenames, breaking the single `koreader_filename` column lookup, and (2) cross-device reading wants a Kindle-style "continue from X%?" prompt when opening a book that was read further on another device.

The Pixel workflow is identical to Kobo: browse OPDS catalog in KOReader, download books, read, auto-sync progress back to server. The server doesn't need to track which device is syncing -- it just stores the latest state. The device decides locally whether to prompt.

## Design principles

- **Server is dumb:** always accept pushes (last-write-wins by timestamp, as today). No device tracking.
- **Device is smart:** on pull, compare server progress vs local. If server is ahead, prompt. If behind, ignore.
- **Filename mapping is many-to-one:** multiple filenames can point to the same book. No device ID needed.
- **Transient data ages off:** filename mappings and sync timestamps expire after 90 days. Re-established on next sync if needed.

## Changes

### 1. Database: many-to-one filename table + cleanup

**File:** `books/helpers/db.py`

Replace the single `koreader_filename` column on `books` with a new table:

```sql
CREATE TABLE koreader_filenames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE(user_id, filename)
);
CREATE INDEX idx_koreader_filenames_book
    ON koreader_filenames(user_id, book_id);
```

- `UNIQUE(user_id, filename)` -- a given filename can only map to one book per user
- `last_seen_at` -- updated on every sync that uses this mapping; used for age-off
- Multiple filenames can map to the same `(user_id, book_id)` -- handles Kobo and Pixel naming the same book differently

**Migration** (`_migrate_koreader_filenames()`):

- Create table + indexes
- Copy existing data: `INSERT INTO koreader_filenames (user_id, book_id, filename, last_seen_at) SELECT user_id, id, koreader_filename, COALESCE(sync_updated_at, datetime('now')) FROM books WHERE koreader_filename IS NOT NULL`
- Drop old `idx_books_koreader_filename` index and `koreader_filename` column

**New db functions** (replacing `get_book_by_koreader_filename` / `set_koreader_filename`):

- `get_book_by_filename(user_id, filename)` -- lookup in `koreader_filenames`, also touch `last_seen_at`
- `set_book_filename(user_id, book_id, filename)` -- INSERT OR REPLACE, sets `last_seen_at` to now

**Cleanup function** (`cleanup_stale_sync_data()`):

- Delete from `koreader_filenames` where `last_seen_at` < 90 days ago
- Clear `progress` and `sync_updated_at` on books where `sync_updated_at` < 90 days ago and `reading_status = 'reading'` (stale in-progress books -- completed books keep their state)
- Called from `init_db()` (runs once per server start, cheap query)

### 2. Backend: simplified sync endpoint

**File:** `books/routes/kobo.py`

**No new fields in request/response models.** The `SyncRequest` and `SyncBookOut` stay the same. The device doesn't need to identify itself.

**`_resolve_book()` resolution cascade (simplified):**

1. `db.get_book_by_filename(user_id, filename)` -- fast indexed lookup
2. Fuzzy match (existing normalized title + author token logic)
3. If matched by either path, call `db.set_book_filename(user_id, book_id, filename)` to cache/refresh

**`_sync_book()` -- no changes to logic.** Last-write-wins by timestamp continues to work. Server always returns its current state. The device handles the UX.

### 3. Plugin: Android support + Kindle-style prompt

**File:** `koreader/plugins/booksync.koplugin/main.lua`

**3a. Configurable books directory:**

- Replace hardcoded `books_dir = "/mnt/onboard/books"` with `getBooksDir()` method
- Platform defaults: Kobo -> `/mnt/onboard/books`, Android -> `DataStorage:getDataDir() .. "/books"`
- User override via menu setting (Android users may need to set this)
- Update `buildFilepathMap()` to use `self:getBooksDir()`

**3b. Kindle-style "continue from" prompt (book open only):**

Modify `onReaderReady` to pass a flag: `syncCurrentBook(true, true)` where the second param means "prompt if server is ahead."

After receiving sync response in `syncCurrentBook()`:

- If `prompt_on_cross_device` is true AND `server.progress > local_progress + 0.01`:
  - Show `ConfirmBox`: "You were at X%. Continue from there?"
  - **Yes**: apply server state + jump reader to position (via `GotoPercentage` event or equivalent)
  - **No**: do nothing (local state stays, next page turn will push it to server naturally)
- Otherwise: apply server state silently as today (handles server-behind and periodic sync cases)

Note: when user declines, we don't need to force-push local state. The next page turn (or book close) will push local progress normally and overwrite the server since it will have a newer timestamp.

**3c. New menu item** in Book Sync submenu:

- Books directory (shows current path, allows override via InputDialog)

**3d. No changes needed for always-on phone.** Sync is event-driven (page turns, book open/close, suspend). A backgrounded KOReader generates no events.

### 4. Always-on phone concern

Not a real problem -- confirmed by reviewing sync triggers:

- `onNetworkConnected`: fires once at KOReader start (WiFi always on) -- just a sync-all, fine
- `onPageUpdate`: only fires during active reading
- `onSuspend`: fires once when app backgrounds
- No timer/polling

## Implementation order

1. `books/helpers/db.py` -- migration, new filename functions, cleanup function
2. `books/routes/kobo.py` -- update `_resolve_book()` to use new functions
3. `koreader/plugins/booksync.koplugin/main.lua` -- books dir, prompt logic
4. `KOBO.md` -- update to reflect multi-device support

## Verification

- Deploy backend first; existing Kobo plugin continues working unchanged (API is the same)
- Verify migration: `koreader_filenames` table has rows migrated from old column, old column gone
- Test with curl: POST two syncs with different filenames but same title/author, confirm both resolve to same `book_id` and both filenames are in `koreader_filenames`
- Test prompt logic: sync book at 50% progress, then open same book locally at 10% -- plugin should prompt
- Test cleanup: insert a `koreader_filenames` row with `last_seen_at` > 90 days ago, restart server, verify it's deleted
- On Kobo: update plugin, verify existing sync still works
- On Android: install KOReader + plugin, configure server + books dir, download book via OPDS, read, verify sync

## Open question: GotoPercentage event

The KOReader event to jump to a percentage position needs verification during implementation. Candidates: `GotoPercentage`, `GotoPage` with calculated page. If neither works cleanly, fallback to applying sidecar state + toast "Progress updated to X%."
