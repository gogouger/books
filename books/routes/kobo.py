"""KOReader sync endpoint."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel

from ..helpers import db
from ..helpers.auth import basic_auth_user
from ..helpers.hardcover import normalize_title

log = logging.getLogger(__name__)
router = APIRouter(prefix="/kobo", tags=["kobo"])

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
    title: str | None = None
    authors: str | None = None
    reading_status: str | None = None
    progress: float | None = None
    rating: float | None = None
    modified: str | None = None


class SyncRequest(BaseModel):
    books: list[SyncBookIn]


class SyncBookOut(BaseModel):
    filename: str
    book_id: int | None = None
    reading_status: str | None = None
    progress: float | None = None
    rating: float | None = None
    date_finished: str | None = None
    modified: str | None = None


class SyncResponse(BaseModel):
    books: list[SyncBookOut]


def _resolve_book(
    user_id: int,
    filename: str,
    title: str | None,
    authors: str | None,
) -> dict | None:
    """Resolve KOReader filename to a book.

    Fast path: lookup by stored koreader_filename.
    Slow path: fuzzy match on normalized title + author
    token overlap, then store the mapping.
    """
    # Fast path: indexed lookup
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


def _parse_ts(ts_str: str | None) -> datetime | None:
    """Parse an ISO timestamp string, always UTC-aware."""
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(
            ts_str.replace("Z", "+00:00")
        )
        # Ensure timezone-aware for comparison
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _sync_book(
    user_id: int,
    book: dict,
    client: SyncBookIn,
) -> SyncBookOut:
    """Compare timestamps, update if client is newer.

    Returns current server state after any updates.
    """
    client_ts = _parse_ts(client.modified)
    server_ts = _parse_ts(book.get("sync_updated_at"))

    client_is_newer = (
        client_ts is not None
        and (server_ts is None or client_ts > server_ts)
    )

    if client_is_newer:
        updates: dict = {
            "sync_updated_at": client.modified,
        }

        # Map KOReader status to server status
        if client.reading_status:
            server_status = _STATUS_TO_SERVER.get(
                client.reading_status
            )
            if server_status:
                updates["reading_status"] = server_status
                if server_status == "read" and not book.get(
                    "date_finished"
                ):
                    updates["date_finished"] = (
                        datetime.now(timezone.utc)
                        .strftime("%Y-%m-%d")
                    )

        if client.progress is not None:
            updates["progress"] = client.progress

        if client.rating is not None:
            updates["rating"] = int(client.rating)

        db.update_book_sync(book["id"], user_id, updates)

        # Refresh book state
        book = db.get_book(book["id"], user_id) or book

    # Map server status back to KOReader status
    kr_status = _STATUS_TO_KOREADER.get(
        book.get("reading_status", "unread")
    )

    modified = book.get("sync_updated_at")
    if not modified:
        modified = datetime.now(timezone.utc).isoformat()

    return SyncBookOut(
        filename=client.filename,
        book_id=book["id"],
        reading_status=kr_status,
        progress=book.get("progress"),
        rating=book.get("rating"),
        date_finished=book.get("date_finished"),
        modified=modified,
    )


@router.post("/sync", response_model=SyncResponse)
def sync_books(
    body: SyncRequest,
    user: basic_auth_user,
) -> SyncResponse:
    """Sync reading state between KOReader and server."""
    user_id = user["user_id"]
    results = []

    for item in body.books:
        book = _resolve_book(
            user_id,
            item.filename,
            item.title,
            item.authors,
        )
        if not book:
            results.append(SyncBookOut(
                filename=item.filename,
                book_id=None,
            ))
            continue

        result = _sync_book(user_id, book, item)
        results.append(result)

    return SyncResponse(books=results)
