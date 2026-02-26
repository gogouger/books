"""KOReader sync endpoint."""

import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from ..helpers import db
from ..helpers.auth import basic_auth_user
from ..helpers.hardcover import normalize_title

log = logging.getLogger(__name__)
router = APIRouter(prefix="/kobo", tags=["kobo"])

PLUGIN_DIR = Path(db.DATA_DIR) / "plugin"
_PLUGIN_FILES = {"main.lua", "_meta.lua"}


def _get_plugin_version() -> int:
    """Read version integer from the published _meta.lua.

    Returns 0 if no plugin has been published yet.
    """
    meta_path = PLUGIN_DIR / "_meta.lua"
    if not meta_path.exists():
        return 0
    text = meta_path.read_text()
    m = re.search(r"version\s*=\s*(\d+)", text)
    return int(m.group(1)) if m else 0


# KOReader status -> server reading_status
_STATUS_TO_SERVER = {
    "reading": "reading",
    "complete": "read",
    "abandoned": "read",
}

# Server reading_status -> KOReader status
_STATUS_TO_KOREADER = {
    "reading": "reading",
    "read": "complete",
}


class SyncBookIn(BaseModel):
    filename: str
    epub_hash: str | None = None
    title: str | None = None
    authors: str | None = None
    reading_status: str | None = None
    progress: float | None = None
    rating: float | None = None


class SyncRequest(BaseModel):
    books: list[SyncBookIn]


class SyncBookOut(BaseModel):
    filename: str
    epub_hash: str | None = None
    book_id: int | None = None
    reading_status: str | None = None
    progress: float | None = None
    rating: float | None = None
    date_finished: str | None = None


class SyncResponse(BaseModel):
    books: list[SyncBookOut]


def _resolve_book(
    user_id: int,
    filename: str,
    title: str | None,
    authors: str | None,
    epub_hash: str | None = None,
) -> dict | None:
    """Resolve KOReader book to a server book record.

    Resolution cascade:
    1. Hash lookup (fastest, exact match on file content)
    2. Filename lookup (cached from previous matches)
    3. Fuzzy match (normalized title + author tokens)
    """
    # Hash lookup: O(1) indexed, works across renames
    if epub_hash:
        book = db.get_book_by_epub_hash(
            user_id, epub_hash
        )
        if book:
            db.set_koreader_filename(
                book["id"], user_id, filename
            )
            return book

    # Filename lookup: indexed, cached from prior matches
    book = db.get_book_by_koreader_filename(
        user_id, filename
    )
    if book:
        return book

    if not title:
        return None

    # Fuzzy match: normalized title + author tokens
    # KOReader replaces : and other unsafe chars with _
    # in filenames; restore before normalizing
    clean_title = title.replace("_", ":")
    norm_title = normalize_title(clean_title)
    author_tokens = set()
    if authors:
        first_author = authors.split(",")[0].strip()
        author_tokens = {
            t.lower() for t in first_author.split()
        }

    conn = db.get_db()
    rows = conn.execute(
        "SELECT * FROM books"
        " WHERE user_id = ? AND is_owned = 1",
        (user_id,),
    ).fetchall()
    conn.close()

    for row in rows:
        book = db._row_to_book(row)
        if normalize_title(book["title"]) != norm_title:
            continue
        if author_tokens:
            existing_tokens = {
                t.lower()
                for t in book["authors"].split(",")[0]
                .strip().split()
            }
            if not (author_tokens & existing_tokens):
                continue
        # Match found - store mapping
        db.set_koreader_filename(
            book["id"], user_id, filename
        )
        log.info(
            "Mapped KOReader '%s' -> book %d (%s)",
            filename, book["id"], book["title"],
        )
        return book

    return None


def _sync_book(
    user_id: int,
    book: dict,
    client: SyncBookIn,
) -> SyncBookOut:
    """Progress-forward sync: always keep the higher progress.

    Progress only resets when status leaves 'reading'.
    """
    server_progress = book.get("progress") or 0.0
    client_progress = client.progress or 0.0

    updates: dict = {
        "sync_updated_at": datetime.now(
            timezone.utc
        ).isoformat(),
    }

    # Status
    if client.reading_status:
        server_status = _STATUS_TO_SERVER.get(
            client.reading_status
        )
        if server_status:
            old_status = book.get("reading_status")
            updates["reading_status"] = server_status
            # Leaving "reading" resets progress
            if (old_status == "reading"
                    and server_status != "reading"):
                updates["progress"] = 0.0
                if server_status == "read" and not book.get(
                    "date_finished"
                ):
                    updates["date_finished"] = (
                        datetime.now(timezone.utc)
                        .strftime("%Y-%m-%d")
                    )

    # Progress: always take the max
    if "progress" not in updates:
        updates["progress"] = max(
            server_progress, client_progress
        )

    if client.rating is not None:
        updates["rating"] = int(client.rating)

    db.update_book_sync(book["id"], user_id, updates)
    book = db.get_book(book["id"], user_id) or book

    kr_status = _STATUS_TO_KOREADER.get(
        book.get("reading_status", "unread")
    )

    return SyncBookOut(
        filename=client.filename,
        epub_hash=book.get("epub_hash"),
        book_id=book["id"],
        reading_status=kr_status,
        progress=book.get("progress"),
        rating=book.get("rating"),
        date_finished=book.get("date_finished"),
    )


@router.get("/ping")
def ping(user: basic_auth_user) -> dict:
    """Health check that validates auth credentials."""
    return {
        "status": "ok",
        "username": user["username"],
        "plugin_version": _get_plugin_version(),
    }


@router.post("/sync", response_model=SyncResponse)
def sync_books(
    body: SyncRequest,
    user: basic_auth_user,
) -> SyncResponse:
    """Sync reading state between KOReader and server."""
    user_id = user["user_id"]
    results = []

    for item in body.books:
        log.info(
            "Sync request: file=%s hash=%s title=%s"
            " progress=%s status=%s",
            item.filename, item.epub_hash, item.title,
            item.progress, item.reading_status,
        )
        book = _resolve_book(
            user_id,
            item.filename,
            item.title,
            item.authors,
            epub_hash=item.epub_hash,
        )
        if not book:
            log.info("No match for: %s", item.filename)
            results.append(SyncBookOut(
                filename=item.filename,
                book_id=None,
            ))
            continue
        log.info(
            "Matched: %s -> book %d (%s)",
            item.filename, book["id"], book["title"],
        )

        result = _sync_book(user_id, book, item)
        results.append(result)

    return SyncResponse(books=results)


@router.post("/plugin/publish")
async def publish_plugin(
    main_lua: UploadFile,
    meta_lua: UploadFile,
    user: basic_auth_user,
) -> dict:
    """Publish a new plugin version (superuser only)."""
    if not user.get("is_superuser"):
        raise HTTPException(403, "Superuser required")

    new_version = _get_plugin_version() + 1

    meta_content = (await meta_lua.read()).decode("utf-8")
    main_content = (await main_lua.read()).decode("utf-8")

    # Patch version in _meta.lua
    if re.search(r"version\s*=\s*\d+", meta_content):
        meta_content = re.sub(
            r"version\s*=\s*\d+",
            f"version = {new_version}",
            meta_content,
        )
    else:
        # Insert version before closing brace
        meta_content = meta_content.rstrip()
        if meta_content.endswith("}"):
            meta_content = (
                meta_content[:-1]
                + f"    version = {new_version},\n"
                + "}\n"
            )

    PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
    (PLUGIN_DIR / "_meta.lua").write_text(meta_content)
    (PLUGIN_DIR / "main.lua").write_text(main_content)

    log.info("Published plugin version %d", new_version)
    return {"version": new_version}


@router.get("/plugin/download/{filename}")
def download_plugin_file(
    filename: str,
    user: basic_auth_user,
) -> PlainTextResponse:
    """Download a published plugin file."""
    if filename not in _PLUGIN_FILES:
        raise HTTPException(404, "File not found")

    filepath = PLUGIN_DIR / filename
    if not filepath.exists():
        raise HTTPException(404, "No plugin published")

    return PlainTextResponse(filepath.read_text())
