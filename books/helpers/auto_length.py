"""Bulk-backfill pages + audio_seconds from Hardcover.

Per book: search Hardcover by title+first-author, take the top hit
whose primary author overlaps with the seed, then look up
books_by_pk(id) for the canonical pages count and the default audio
edition's audio_seconds. Throttled like auto_tags.
"""

import asyncio
import logging
import re

from . import db, hardcover

log = logging.getLogger(__name__)

CONCURRENCY = 5
DELAY_BETWEEN = 0.5


def _author_tokens(name: str) -> set[str]:
    return {
        t for t in re.findall(r"[a-z]+", (name or "").lower())
        if len(t) >= 2
    }


async def _fetch_length(book_id: int) -> tuple[int | None, int | None]:
    """Return (pages, audio_seconds) for a Hardcover book id."""
    gql = """
    {
      books_by_pk(id: %d) {
        pages
        default_audio_edition { audio_seconds }
      }
    }
    """ % book_id
    try:
        data = await hardcover._graphql(gql)
    except Exception:
        return (None, None)
    rec = (data.get("data") or {}).get("books_by_pk") or {}
    pages = rec.get("pages")
    audio = (rec.get("default_audio_edition") or {}).get("audio_seconds")
    return (
        int(pages) if pages else None,
        int(audio) if audio else None,
    )


async def backfill_lengths(user_id: int) -> dict:
    """For every book without pages OR audio_seconds, hit Hardcover."""
    conn = db.get_db()
    rows = conn.execute(
        """
        SELECT id, title, authors, pages, audio_seconds
        FROM books
        WHERE user_id = ?
          AND (pages IS NULL OR audio_seconds IS NULL)
        """,
        (user_id,),
    ).fetchall()
    conn.close()

    summary = {
        "total_candidates": len(rows),
        "filled_pages": 0,
        "filled_audio": 0,
        "no_hc_match": 0,
        "skipped": 0,
    }
    if not rows:
        return summary

    sem = asyncio.Semaphore(CONCURRENCY)
    results: list[tuple[int, int | None, int | None]] = []

    async def process(book: dict) -> None:
        first_author = (book["authors"] or "").split(",", 1)[0].strip()
        async with sem:
            try:
                hits = await hardcover.search_books(
                    f"{book['title']} {first_author}", per_page=3,
                )
            except Exception:
                results.append((book["id"], None, None))
                return
            await asyncio.sleep(DELAY_BETWEEN)

        if not hits:
            results.append((book["id"], None, None))
            return

        seed_tokens = _author_tokens(first_author)
        match = None
        for h in hits:
            hit_author = h.get("author") or ""
            if not seed_tokens or seed_tokens & _author_tokens(hit_author):
                match = h
                break
        if match is None:
            match = hits[0]

        async with sem:
            pages, audio = await _fetch_length(int(match["id"]))
            await asyncio.sleep(DELAY_BETWEEN)
        results.append((book["id"], pages, audio))

    await asyncio.gather(*(process(dict(r)) for r in rows))

    for bid, pages, audio in results:
        if pages is None and audio is None:
            summary["no_hc_match"] += 1
            continue
        patch: dict = {}
        if pages is not None:
            patch["pages"] = pages
            summary["filled_pages"] += 1
        if audio is not None:
            patch["audio_seconds"] = audio
            summary["filled_audio"] += 1
        try:
            db.update_book(bid, user_id, patch)
        except Exception:
            log.exception("update failed book=%d", bid)
            summary["skipped"] += 1

    return summary
