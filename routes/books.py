import logging
import shutil
import uuid
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..helpers import db
from ..helpers.auth import library_owner, optional_user, require_owner
from ..helpers.metadata import (
    extract_epub_metadata,
    search_google_books,
    search_open_library,
)

from ..helpers.db import DATA_DIR

log = logging.getLogger(__name__)
router = APIRouter(tags=["books"])


class BookUpdate(BaseModel):
    title: str | None = None
    sort_title: str | None = None
    authors: str | None = None
    author_sort: str | None = None
    series: str | None = None
    series_index: float | None = None
    description: str | None = None
    isbn: str | None = None
    goodreads_id: str | None = None
    tags: list[str] | None = None
    date_finished: str | None = None
    rating: float | None = None
    is_read: int | None = None


class MetadataSearchRequest(BaseModel):
    query: str
    source: str = "google"


def _is_owner(
    viewer: dict | None, owner: dict
) -> bool:
    """Check if the viewer is the library owner."""
    if viewer is None:
        return False
    return viewer["user_id"] == owner["id"]


# --- Read-only routes (anonymous or authenticated) ---


@router.get("/books")
def list_books(
    owner: library_owner,
    viewer: optional_user,
    q: str | None = None,
    series: str | None = None,
    is_read: int | None = None,
    min_rating: float | None = None,
    max_rating: float | None = None,
    sort: str = "title",
    order: str = "asc",
    limit: int = Query(default=50, le=200),
    offset: int = 0,
) -> dict:
    user_id = owner["id"]
    books = db.get_books(
        user_id,
        q=q,
        series=series,
        is_read=is_read,
        min_rating=min_rating,
        max_rating=max_rating,
        sort=sort,
        order=order,
        limit=limit,
        offset=offset,
    )
    total = db.count_books(
        user_id,
        q=q,
        series=series,
        is_read=is_read,
        min_rating=min_rating,
        max_rating=max_rating,
    )
    return {
        "books": books,
        "total": total,
        "is_owner": _is_owner(viewer, owner),
        "library_owner": {
            "username": owner["username"],
            "display_name": owner["display_name"],
        },
    }


@router.get("/books/{book_id}")
def get_book(
    book_id: int,
    owner: library_owner,
    viewer: optional_user,
) -> dict:
    book = db.get_book(book_id, owner["id"])
    if book is None:
        raise HTTPException(
            status_code=404, detail="Book not found"
        )
    book["is_owner"] = _is_owner(viewer, owner)
    book["library_owner"] = {
        "username": owner["username"],
        "display_name": owner["display_name"],
    }
    return book


@router.get("/books/{book_id}/cover")
def get_cover(
    book_id: int,
    owner: library_owner,
    _viewer: optional_user,
) -> FileResponse:
    book = db.get_book(book_id, owner["id"])
    if book is None or not book.get("cover_filename"):
        raise HTTPException(
            status_code=404, detail="Cover not found"
        )
    cover_path = (
        DATA_DIR
        / "covers"
        / str(owner["id"])
        / book["cover_filename"]
    )
    if not cover_path.exists():
        raise HTTPException(
            status_code=404, detail="Cover file missing"
        )
    return FileResponse(
        str(cover_path), media_type="image/jpeg"
    )


# --- Owner-only routes ---


@router.post("/books")
async def add_book(
    file: UploadFile,
    payload: require_owner,
    title: str | None = None,
    authors: str | None = None,
    series: str | None = None,
    series_index: float | None = None,
) -> dict:
    user_id = payload["user_id"]

    # Save uploaded epub to temp location
    temp_path = DATA_DIR / f"temp_{uuid.uuid4()}.epub"
    try:
        with open(temp_path, "wb") as f:
            content = await file.read()
            f.write(content)

        # Extract metadata from epub
        meta = extract_epub_metadata(str(temp_path))

        book_title = title or meta["title"] or file.filename or "Unknown"
        book_authors = authors or meta["authors"] or "Unknown"
        sort_title = _make_sort_title(book_title)

        now = datetime.now(timezone.utc).isoformat()

        # Insert book record
        book_id = db.insert_book(
            user_id=user_id,
            title=book_title,
            sort_title=sort_title,
            authors=book_authors,
            author_sort=_make_author_sort(book_authors),
            series=series,
            series_index=series_index,
            description=meta.get("description"),
            cover_filename=None,
            file_path=f"{book_id}.epub" if False else None,
            isbn=meta.get("isbn"),
            goodreads_id=None,
            tags=meta.get("tags"),
            date_added=now,
            date_finished=None,
            rating=None,
            is_read=0,
        )

        # Move epub to final location
        user_files = DATA_DIR / "files" / str(user_id)
        user_files.mkdir(parents=True, exist_ok=True)
        final_path = user_files / f"{book_id}.epub"
        shutil.move(str(temp_path), str(final_path))

        # Update file_path in DB
        db.update_book(
            book_id, user_id, {"file_path": f"{book_id}.epub"}
        )

        # Save cover if extracted
        if meta.get("cover_data"):
            user_covers = DATA_DIR / "covers" / str(user_id)
            user_covers.mkdir(parents=True, exist_ok=True)
            cover_path = user_covers / f"{book_id}.jpg"
            cover_path.write_bytes(meta["cover_data"])
            db.update_book(
                book_id,
                user_id,
                {"cover_filename": f"{book_id}.jpg"},
            )

        return db.get_book(book_id, user_id)
    finally:
        if temp_path.exists():
            temp_path.unlink()


@router.patch("/books/{book_id}")
def update_book(
    book_id: int,
    updates: BookUpdate,
    payload: require_owner,
) -> dict:
    user_id = payload["user_id"]
    update_data = updates.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(
            status_code=400, detail="No updates provided"
        )
    success = db.update_book(book_id, user_id, update_data)
    if not success:
        raise HTTPException(
            status_code=404, detail="Book not found"
        )
    return db.get_book(book_id, user_id)


@router.delete("/books/{book_id}")
def delete_book(
    book_id: int,
    payload: require_owner,
) -> dict:
    user_id = payload["user_id"]
    book = db.get_book(book_id, user_id)
    if book is None:
        raise HTTPException(
            status_code=404, detail="Book not found"
        )

    # Delete files
    if book.get("cover_filename"):
        cover = (
            DATA_DIR
            / "covers"
            / str(user_id)
            / book["cover_filename"]
        )
        if cover.exists():
            cover.unlink()
    if book.get("file_path"):
        epub = (
            DATA_DIR
            / "files"
            / str(user_id)
            / book["file_path"]
        )
        if epub.exists():
            epub.unlink()

    db.delete_book(book_id, user_id)
    return {"success": True}


@router.get("/books/{book_id}/file")
def get_file(
    book_id: int,
    payload: require_owner,
) -> FileResponse:
    book = db.get_book(book_id, payload["user_id"])
    if book is None or not book.get("file_path"):
        raise HTTPException(
            status_code=404, detail="File not found"
        )
    file_path = (
        DATA_DIR
        / "files"
        / str(payload["user_id"])
        / book["file_path"]
    )
    if not file_path.exists():
        raise HTTPException(
            status_code=404, detail="File missing"
        )
    return FileResponse(
        str(file_path),
        media_type="application/epub+zip",
        filename=f"{book['title']}.epub",
    )


@router.post("/metadata/search")
async def search_metadata(
    req: MetadataSearchRequest,
    _payload: require_owner,
) -> dict:
    if req.source == "openlibrary":
        results = await search_open_library(req.query)
    else:
        results = await search_google_books(req.query)
    return {"results": results}


@router.post("/metadata/extract")
async def extract_metadata(
    file: UploadFile,
    _payload: require_owner,
) -> dict:
    temp_path = DATA_DIR / f"temp_{uuid.uuid4()}.epub"
    try:
        with open(temp_path, "wb") as f:
            content = await file.read()
            f.write(content)
        meta = extract_epub_metadata(str(temp_path))
        meta.pop("cover_data", None)
        return meta
    finally:
        if temp_path.exists():
            temp_path.unlink()


def _make_sort_title(title: str) -> str:
    lower = title.lower()
    for prefix in ("the ", "a ", "an "):
        if lower.startswith(prefix):
            return title[len(prefix):] + ", " + title[:len(prefix) - 1]
    return title


def _make_author_sort(authors: str) -> str:
    parts = []
    for author in authors.split(","):
        author = author.strip()
        names = author.split()
        if len(names) > 1:
            parts.append(f"{names[-1]}, {' '.join(names[:-1])}")
        else:
            parts.append(author)
    return " & ".join(parts)
