"""Recommendation API: GET /recommendations + dismiss/add/refresh.

Cache strategy: 24h in-memory per user_id. Dismissing or adding a book
invalidates that user's cache so the dismissed/added item disappears on
the next reload.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..helpers import db, hardcover, recommend
from ..helpers.auth import require_owner
from ..helpers.db import DATA_DIR

log = logging.getLogger(__name__)
router = APIRouter(prefix="/recommendations", tags=["recommendations"])

CACHE_TTL_SECONDS = 24 * 60 * 60

_cache: dict[int, dict] = {}
_locks: dict[int, asyncio.Lock] = {}


async def _build(user_id: int) -> dict:
    dismissed = db.get_dismissed_hc_ids(user_id)
    cont = recommend.next_in_series(user_id)
    loved, similar = await asyncio.gather(
        recommend.more_from_loved_authors(user_id, dismissed),
        recommend.similar_to_favorites(user_id, dismissed),
    )
    await recommend.enrich_with_covers(loved + similar)
    return {
        "continue": cont,
        "loved_authors": loved,
        "similar_to_favorites": similar,
        "generated_at": time.time(),
    }


@router.get("")
async def list_recommendations(auth: require_owner) -> dict:
    user_id = auth["user_id"]
    cached = _cache.get(user_id)
    if cached and (time.time() - cached["generated_at"]) < CACHE_TTL_SECONDS:
        return cached

    lock = _locks.setdefault(user_id, asyncio.Lock())
    async with lock:
        cached = _cache.get(user_id)
        if (
            cached
            and (time.time() - cached["generated_at"]) < CACHE_TTL_SECONDS
        ):
            return cached
        result = await _build(user_id)
        _cache[user_id] = result
        return result


class DismissPayload(BaseModel):
    hc_book_id: int


@router.post("/dismiss")
def dismiss_rec(payload: DismissPayload, auth: require_owner) -> dict:
    user_id = auth["user_id"]
    db.dismiss_recommendation(user_id, payload.hc_book_id)
    _cache.pop(user_id, None)
    return {"success": True}


class AddFromHCPayload(BaseModel):
    hc_book_id: int


@router.post("/add-from-hc")
async def add_from_hardcover(
    payload: AddFromHCPayload, auth: require_owner,
) -> dict:
    """Add a Hardcover book to the user's library as unowned/unread.

    Pulls full detail, resolves series_link_id if applicable, downloads
    the cover. Returns the new book_id (or the existing one if a match
    was already in-library — that's not really an error).
    """
    user_id = auth["user_id"]
    detail = await hardcover.fetch_book_detail(payload.hc_book_id)
    if not detail:
        raise HTTPException(
            status_code=404,
            detail="Hardcover book not found",
        )

    title = (detail.get("title") or "").strip()
    authors = (detail.get("authors") or "").strip()
    if not title or not authors:
        raise HTTPException(
            status_code=400,
            detail="Hardcover record missing title or authors",
        )

    series_name = (detail.get("series_name") or "").strip()
    series_index = detail.get("series_index")
    series_link_id = (
        db.get_or_create_series_link(user_id, series_name)
        if series_name else None
    )

    # If the book is already in the library (owned or unowned ghost),
    # don't duplicate it — just return the existing id.
    unowned_id = db.find_unowned_match(
        user_id, title,
        series_link_id=series_link_id,
        series_index=series_index,
    )
    owned_match = db.find_owned_match(
        user_id, title, authors,
        series_link_id=series_link_id,
        series_index=series_index,
    )
    existing_id = unowned_id or (owned_match["id"] if owned_match else None)

    now = datetime.now(timezone.utc).isoformat()
    if existing_id:
        book_id = existing_id
    else:
        book_id = db.insert_book(
            user_id=user_id,
            title=title,
            sort_title=db.make_sort_title(title),
            authors=authors,
            author_sort=db.make_author_sort(authors),
            series=series_name or None,
            series_index=series_index,
            description=detail.get("description") or None,
            cover_filename=None,
            file_path=None,
            isbn=detail.get("isbn") or None,
            goodreads_id=None,
            tags=None,
            date_added=now,
            date_finished=None,
            rating=None,
            reading_status="unread",
            series_link_id=series_link_id,
            published_date=detail.get("published_date") or None,
            is_owned=0,
            book_format="physical",
        )

    # Cover download — best effort. Don't fail the add if it 404s.
    cover_url = detail.get("cover_url")
    if cover_url:
        try:
            async with httpx.AsyncClient(
                follow_redirects=True, timeout=20
            ) as client:
                resp = await client.get(cover_url)
                if (
                    resp.status_code == 200
                    and len(resp.content) > 1500
                ):
                    user_covers = (
                        DATA_DIR / "covers" / str(user_id)
                    )
                    user_covers.mkdir(parents=True, exist_ok=True)
                    (user_covers / f"{book_id}.jpg").write_bytes(
                        resp.content
                    )
                    db.update_book(book_id, user_id, {
                        "cover_filename": f"{book_id}.jpg",
                        "cover_updated_at": now,
                    })
        except Exception:
            log.exception("cover download failed for %s", cover_url)

    _cache.pop(user_id, None)
    return {"book_id": book_id, "title": title}


@router.post("/refresh")
async def refresh_recs(auth: require_owner) -> dict:
    user_id = auth["user_id"]
    _cache.pop(user_id, None)
    result = await _build(user_id)
    _cache[user_id] = result
    return result
