# Kobo + KOReader Integration

## Device

- **Model:** Kobo (spaBW)
- **Firmware:** Linux kobo 4.9.77, armv7l
- **OS libc:** glibc 2.11.1 (very old -- only static binaries or matching-libc binaries work)
- **IP:** 192.168.1.253 (DHCP, may change)
- **Storage:** 12.5G total on `/mnt/onboard`, ~11G free with ~1000 books
- **Book count:** 998 EPUBs at `/mnt/onboard/books/`

## Architecture

Use KOReader as primary reader. Books are downloaded on-demand via OPDS, not
bulk-synced to the device.

- OPDS catalog has rich hierarchical navigation (filters, letter browse) to
  handle 980+ books on e-ink
- KOReader downloads individual books when selected in OPDS browser
- No need to manage 1000 files on device storage
- Gesture shortcut: bottom-right corner tap opens OPDS browser directly
  (KOReader Gesture Manager > `opds_show_catalog` action)

Nickel is still installed but not the primary reading interface. NickelMenu
provides a launcher for KOReader.

```
KOReader (primary reader)          Books Server (FastAPI)
+------------------+               +------------------------+
| OPDS browser     | --WiFi-->     | /opds/ (rich navigation|
| (find + download)|               |  with filters + counts)|
|                  |               |                        |
| Read books       |               | /api/books/ (web UI)   |
| Rate on finish   |               |                        |
| booksync plugin  | --WiFi-->     | /api/kobo/sync         |
| (progress sync)  |               | (JSON, Basic Auth)     |
| SSH server       | <--SFTP--     | (device management)    |
+------------------+               +------------------------+

- Only 6-10 active books on device at a time
- Server is source of truth for library
- OPDS navigation replaces bulk sync
- Ratings: on-device via KOReader, synced to server
- Web UI: browse library, rate books, manage metadata
```

## SSH Access

KOReader runs a dropbear SSH server on port 2222. This is the only SSH access
method. Remote commands work directly.

```bash
ssh -p 2222 root@192.168.1.253 "uname -a"
ssh -p 2222 root@192.168.1.253 "ls /mnt/onboard/books/"
```

Passwordless login: public key at
`/mnt/onboard/.adds/koreader/settings/SSH/authorized_keys`

SFTP server available at `/mnt/onboard/.adds/koreader/sftp-server`.

**Limitation:** Only available while KOReader is running. If KOReader is not
running (e.g. in Nickel), SSH is not available.

## File Transfer

SFTP via KOReader's SSH server:

```bash
sftp -P 2222 root@192.168.1.253
```

## OPDS

- Catalog: `https://books.mclauthlin.com/opds/`
- Auth: HTTP Basic Auth (username/password via `scripts/set_password.py`)
- Page size: 2000 (KOReader doesn't follow pagination)
- All feed links use relative paths (KOReader auth quirk)

### Views

| Route | Description |
|-------|-------------|
| `/opds/` | Root - links to each view with total count |
| `/opds/all` | All books, alpha by title |
| `/opds/series` | Series names with counts |
| `/opds/authors` | Author names with counts |
| `/opds/recent` | Ordered by date_added desc |
| `/opds/activity` | Ordered by date_finished desc |
| `/opds/search?q=...` | Full-text search |

### Stackable Filters (query params)

Every view (except root) is a navigation feed showing "Show Books (N)" at top
plus available filter entries. Adding `?show=1` switches to acquisition feed.

| Param | Values | Effect |
|-------|--------|--------|
| `status` | `unread`, `read`, `reading` | Filter by reading_status |
| `rated` | `yes`, `no` | Has/hasn't got a rating |
| `rating` | `1`-`5` | Exact star rating (shown after rated=yes) |
| `favorite` | `yes` | Only favorites |
| `letter` | `A`-`Z`, `#` | First letter of sort_title (shown when > 50 results) |
| `show` | `1` | Switch to acquisition feed |

Filters hide themselves when applied or nonsensical (e.g., no rating options
when rated=no). Letter filter uses sort_title (strips leading articles).

## Sync Architecture: KOReader Plugin

Reading progress, status, and ratings sync between KOReader and the Books server
via a custom KOReader plugin (`booksync.koplugin`). No Nickel involvement.

```
KOReader                            Books Server (FastAPI)
+------------------+                +------------------------+
| .sdr sidecars    | ---WiFi--->   | POST /api/kobo/sync    |
| (percent_finished,               | (JSON, Basic Auth)     |
|  summary.status, |               |                        |
|  summary.rating) | <--WiFi---    | Response: merged state |
|                  |               |                        |
| booksync.koplugin|               | Fuzzy match filename   |
+------------------+               | -> book_id on first    |
                                   | contact, then cached   |
                                    +------------------------+
```

### How It Works

1. KOReader saves files as `Author - Title.epub` (not by book ID)
2. Plugin sends filename + title + authors to server
3. Server resolves to book_id via `koreader_filename` index (fast) or fuzzy match
   (normalized title + author token overlap) on first contact
4. Last-write-wins: whichever side has newer `modified` timestamp wins for all fields
5. Server returns current state; plugin applies if server is newer

### Sync Triggers

| Event | Action |
|-------|--------|
| Book opened | Sync this book |
| Every ~20 page turns | Push this book |
| Book closed | Push this book |
| Device suspend | Push this book |
| WiFi connected | Sync all books with sidecars |
| WiFi disconnecting | Push all dirty books |
| Menu > Book Sync > Sync all | Sync all books |

### Plugin Location

`/mnt/onboard/.adds/koreader/plugins/booksync.koplugin/`

### Status Mapping

| KOReader | Server |
|----------|--------|
| `nil` | `unread` |
| `reading` | `reading` |
| `complete` | `read` |
| `abandoned` | `read` |

## Installed Mods

| Mod | Location | Purpose |
|-----|----------|---------|
| NickelMenu | `.adds/nm/` | Adds custom menu entries to Nickel, launches KOReader |
| KOReader | `.adds/koreader/` | Primary e-reader |

## References

- KOReader User Guide: https://koreader.rocks/user_guide/
- KOReader Wiki: https://github.com/koreader/koreader/wiki
- KOReader SSH Wiki: https://github.com/koreader/koreader/wiki/SSH
- Opinionated KOReader Guide: https://www.reddit.com/r/kobo/comments/1gv4jte/an_opinionated_guide_to_koreader/
- OPDS 1.2 spec: https://specs.opds.io/opds-1.2.html
- KOReader releases: https://github.com/koreader/koreader/releases
