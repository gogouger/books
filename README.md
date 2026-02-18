# Books

Personal book library webapp for managing the family's ebook collection.

## Features

- Browse books with covers in a responsive grid
- Track read status with dates and ratings (half-star increments)
- Group and browse by series with read progress
- Search and filter by title, author, read status, rating
- Send books to Kindle via email
- Upload new EPUBs with automatic metadata extraction
- Per-user libraries (andy, liz, ada)

## Stack

- **API**: FastAPI + SQLite
- **Frontend**: TypeScript + Bootstrap 5 (esbuild bundled)
- **Serving**: nginx (static files + covers) + gunicorn/uvicorn (API)
- **Port**: 60022

## Development

```bash
# Install Python deps
uv sync

# Build UI
cd books/ui && npx esbuild src/main.ts --bundle --outfile=dist/app.js --watch --sourcemap

# Run API locally
uv run uvicorn books.main:app --reload --port 8000
```

## Deploy

```bash
./deploy.sh
```

Builds the UI, syncs source to `/data/containers/books/`, and restarts
Docker containers on port 60022.

## Calibre Import

One-time import from existing Calibre libraries:

```bash
python scripts/import_calibre.py
```
