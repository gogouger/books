# Books

Personal ebook library webapp. FastAPI backend, vanilla TypeScript SPA frontend, SQLite database.

## Development Commands

```bash
# Install Python dependencies
uv sync

# Run API dev server
uv run uvicorn books.main:app --reload --port 8000

# Build/watch frontend (from books/ui/)
cd books/ui && npx esbuild src/main.ts --bundle --outfile=dist/app.js --watch --sourcemap

# Deploy (builds UI, rsyncs to server, rebuilds containers)
./deploy.sh
```

## Architecture

### Backend

- **Framework**: FastAPI app in `books/main.py`
- **Routes**: `books/routes/` - auth, books, series, kindle
- **Helpers**: `books/helpers/` - db, auth (Google OAuth), email (SMTP), metadata (EPUB/API)
- **Database**: Raw SQLite via `sqlite3` (no ORM), WAL mode, foreign keys enabled
- **Schema**: Defined inline in `books/helpers/db.py` - tables: `users`, `books`
- **Config**: python-decouple reading from `.env`

### Frontend

- **Stack**: Vanilla TypeScript SPA, Bootstrap 5 (CDN), Bootstrap Icons (CDN)
- **Entry**: `books/ui/src/main.ts` with hash-based router (`books/ui/src/router.ts`)
- **Pages**: `books/ui/src/pages/` - login, library, book-detail, add-book, series-list, series-view
- **Components**: `books/ui/src/components/` - book-card, book-grid, filter-bar, rating-stars
- **Auth module**: `books/ui/src/auth.ts` - Google Sign-In integration, token in sessionStorage, auto-refresh scheduling
- **API client**: `books/ui/src/api.ts` - Bearer auth, 401 retry via Google prompt, blob downloads
- **Build**: esbuild bundles to `books/ui/dist/app.js`, target ES2020, IIFE format

### Deployment

- **Docker Compose** with two services on port 60022:
  - `nginx` (alpine) - serves static frontend, proxies `/api/` to API, serves `/covers/` with 7-day cache
  - `api` - gunicorn + uvicorn workers, built with uv
- **Config files**: `docker-compose.yml`, `nginx.conf`, `deploy.sh`
- Deployed to `/data/containers/books/`

### Data Storage

- All data under `$BOOKS_DATA_DIR` (from `.env`):
  - `books.db` - SQLite database
  - `users.json` - email-to-username mapping for Google OAuth
  - `covers/{user_id}/{book_id}.jpg` - cover images (served by nginx)
  - `files/{user_id}/{book_id}.epub` - ebook files (served by FastAPI with auth)

## Key Conventions

- **Auth**: Google OAuth via `google-auth` library. Frontend gets Google ID token, backend validates with `id_token.verify_oauth2_token()`. `require_user` Annotated dependency on all protected routes. `BOOKS_SECURE=false` bypasses auth in dev (hardcoded user_id=1). `users.json` in `$BOOKS_DATA_DIR` maps Google emails to local usernames.
- **User scoping**: All book queries filter by `user_id` from token. File paths include `/{user_id}/` subdirectory.
- **Tags**: Stored as JSON string in SQLite TEXT column, serialized with `json.dumps`/`json.loads`
- **Sort title**: Auto-generated, strips leading "The"/"A"/"An" for alphabetical sorting
- **Series index**: REAL type, supports decimal positions (e.g., 1.5)
- **Metadata**: Extracted from EPUB via ebooklib, or searched via Google Books / Open Library APIs
