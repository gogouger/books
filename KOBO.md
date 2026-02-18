# Kobo + KOReader Integration Plan

Replace Kindle + Goodreads workflow with Kobo + KOReader + self-hosted Books app.

## Goal

Replicate the current reading flow with own infrastructure:

1. Browse personal library on e-reader over WiFi (OPDS catalog)
2. Download and read books
3. Get prompted to rate when finished (KOReader book status dialog)
4. Rating + reading status sync back to Books app automatically

## Hardware

**Recommended devices** (all support KOReader without jailbreaking):

- **Kobo Clara 2E** (~$130) - 6" screen, waterproof, USB-C, good value
- **Kobo Libra 2** (~$150) - 7" screen, page-turn buttons, waterproof
- **Kobo Sage** (~$230) - 8" screen, stylus support, if you want larger

Any current Kobo works. KOReader installs by copying files to the device via USB -- no
jailbreak, no firmware modification, no risk.

## KOReader Setup on Kobo

1. Install NickelMenu: copy `KoboRoot.tgz` to `.kobo/` on device, eject, device reboots
2. Install KOReader: extract release archive to root of Kobo storage
3. NickelMenu adds a "KOReader" entry to the Kobo menu -- tap to launch
4. Stock Kobo firmware is preserved, dual-boot between stock reader and KOReader

References:

- NickelMenu: https://github.com/pgaskin/NickelMenu
- KOReader releases: https://github.com/koreader/koreader/releases (get the Kobo build)
- KOReader wiki: https://github.com/koreader/koreader/wiki

## Architecture

```
Kobo (KOReader)                     Books Server (FastAPI)
+------------------+                +------------------------+
| OPDS client      | ---WiFi--->   | /opds/ routes          |
| (browse + download)              | (Atom XML feeds)       |
|                  |                |                        |
| kosync plugin    | ---WiFi--->   | /kosync/ routes        |
| (reading position)               | (4 REST endpoints)     |
|                  |                |                        |
| custom plugin    | ---WiFi--->   | /api/books/{id} PATCH  |
| (rating + status)                | (existing endpoint)    |
+------------------+                +------------------------+
```

## Server-Side Work

### 1. OPDS Feed (~100-200 lines)

Add routes to serve the book catalog as OPDS (Atom XML):

- `GET /opds/` - Root navigation feed (links to "All Books", "Series", etc.)
- `GET /opds/all` - Acquisition feed listing all books with download links
- `GET /opds/series/{name}` - Books in a specific series
- `GET /opds/search?q=...` - Search results (OpenSearch)

Each book entry includes:

- Title, author, description
- Download link (`rel="http://opds-spec.org/acquisition"`, type `application/epub+zip`)
- Cover image link (`rel="http://opds-spec.org/image"`)

Auth: HTTP Basic Auth (KOReader supports it). Map credentials to existing user accounts.

OPDS is simple Atom XML. No library needed -- generate with `xml.etree.ElementTree` or
templates. Key MIME types:

- Navigation feed: `application/atom+xml;profile=opds-catalog;kind=navigation`
- Acquisition feed: `application/atom+xml;profile=opds-catalog;kind=acquisition`
- EPUB files: `application/epub+zip`

### 2. kosync Endpoints (4 endpoints, ~50-100 lines)

Implement the KOReader progress sync protocol:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/kosync/users/create` | POST | Register device (username + password) |
| `/kosync/users/auth` | GET | Authenticate (HTTP Basic via X-Auth-User/X-Auth-Key headers) |
| `/kosync/syncs/progress` | PUT | Push reading position (document hash, progress, percentage) |
| `/kosync/syncs/progress/{document}` | GET | Get reading position for a document |

Document identification: MD5 hash of file contents. Need to store a mapping from MD5 hash
to book_id in the database (compute on upload/import).

Auth uses `X-Auth-User` and `X-Auth-Key` (MD5 of password) headers.

Data to store: `document` (hash), `progress` (position string), `percentage` (float),
`device`, `device_id`, `timestamp`.

This gives real-time reading progress sync over WiFi. When KOReader is configured to
point at the Books server, every reading session syncs position automatically.

### 3. Rating/Status Sync (custom KOReader plugin)

This is the piece that doesn't exist yet anywhere. KOReader's built-in Book Status dialog
already prompts for rating (1-5 stars) and status (reading/complete/abandoned) when you
finish a book. But it only saves to a local sidecar file.

**Custom plugin approach** (~100-200 lines of Lua):

- Hook into KOReader's `BookStatusWidget` close event or the document close event
- Read the rating and status from the book's sidecar metadata
- POST to the Books API: `PATCH /api/books/{id}` with `{rating, is_read, date_finished}`
- Need to identify which server-side book this is -- use the same MD5 hash as kosync,
  or match by title/author

Plugin location on device: `koreader/plugins/booksync.koplugin/`

Reference plugins to study:

- `plugins/kosync.koplugin/` - HTTP sync, auth, server communication
- `plugins/statistics.koplugin/` - Reading event hooks
- `plugins/bookstatuswidget.koplugin/` - The rating/status dialog itself (if it exists
  as separate plugin)

### 4. Database Changes

New table or columns needed:

- `books.file_hash` (TEXT) - MD5 hash of EPUB file, computed on upload. Used by kosync
  to identify books. Index on `(user_id, file_hash)`.
- New table `reading_progress` - kosync position data:
  - `user_id`, `document_hash`, `progress`, `percentage`, `device`, `device_id`,
    `timestamp`

The existing `rating`, `is_read`, and `date_finished` columns on `books` already handle
the rating/status data. No changes needed there.

## KOReader Configuration (on device)

Once server-side is built:

1. **OPDS catalog**: Search icon > OPDS catalog > + > enter server URL
   (e.g., `https://books.example.com/opds/`)
2. **Progress sync**: Settings > Progress sync > Custom sync server >
   enter URL (e.g., `https://books.example.com/kosync/`)
3. **Rating sync plugin**: Copy custom plugin to `koreader/plugins/booksync.koplugin/`

## Alternative: Stock Kobo Firmware Data

If reading books in the stock Kobo reader instead of KOReader, data is in
`/mnt/onboard/.kobo/KoboReader.sqlite` on the device:

```sql
SELECT Title, Attribution, ReadStatus, ___PercentRead, DateLastRead
FROM content WHERE ContentType = 6;
-- ReadStatus: 0=unread, 1=reading, 2=finished

SELECT c.Title, r.Rating
FROM content c JOIN ratings r ON c.ContentID = r.ContentID
WHERE c.ContentType = 6;
```

Could write a USB sync script using `kobuddy` (Python) to extract this data periodically.
Less seamless than KOReader WiFi sync but works as a fallback.

## Implementation Order

1. **OPDS feed** - enables browsing/downloading books on KOReader over WiFi
2. **kosync endpoints** - enables real-time reading position sync
3. **File hash computation** - needed for kosync document identification
4. **Custom KOReader plugin** - enables rating/status sync back to server
5. **Frontend updates** - show reading progress percentage in the web UI

Steps 1-3 are pure server-side Python. Step 4 is Lua on the device. Step 5 is TypeScript.

## Useful References

- OPDS 1.2 spec: https://specs.opds.io/opds-1.2.html
- kosync API: https://github.com/koreader/koreader/blob/master/plugins/kosync.koplugin/api.json
- KOReader plugin dev: https://github.com/koreader/koreader/wiki/Plugin-system
- pyopds-server (reference): https://github.com/c4software/pyopds-server
- koreader-sync-server (reference): https://github.com/koreader/koreader-sync-server
- kobuddy (Kobo DB parser): https://github.com/karlicoss/kobuddy
- BookLore (has KOReader sync): https://github.com/booklore-app/booklore
- NickelMenu: https://github.com/pgaskin/NickelMenu
