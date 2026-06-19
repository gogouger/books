"""Bulk auto-fill sub-genre tags from Hardcover.

For every book that has no tags yet, search Hardcover by title + first
author, take the top hit whose primary author tokens overlap with the
seed, save the normalized `genres` list back to the book's tags column.

Normalization shares the alias table with metrics.compute_metrics so the
auto-filled tags collapse into the same buckets the dashboard already
uses ('sci-fi' / 'science-fiction' / 'SF' → 'Science Fiction').
"""

import asyncio
import json
import logging
import re
from typing import Any

from . import db, hardcover
from . import metrics as metrics_helper

log = logging.getLogger(__name__)

CONCURRENCY = 5
DELAY_BETWEEN = 0.4
# Hardcover genres are noisy — top-level catch-all categories that apply
# to virtually any book aren't useful as sub-genre tags. Drop them so the
# saved tag list captures the distinctive labels.
_BROAD = frozenset({
    "Fiction", "Nonfiction", "Adult", "adult",
    "Science Fiction & Fantasy", "Literature & Fiction",
    "Magic", "Action & Adventure", "General",
    # Non-English variants leak through occasionally.
    "Adulte", "Roman", "Fantastico", "Aventure", "Aventures",
})


def _author_tokens(name: str) -> set[str]:
    return {
        t for t in re.findall(r"[a-z]+", (name or "").lower())
        if len(t) >= 2
    }


def _empty_tag_row(raw: str | None) -> bool:
    """True if tags column is logically empty (covers all legacy shapes)."""
    if raw is None:
        return True
    s = raw.strip()
    if not s or s in ('""', "''", "[]"):
        return True
    # Try parsing — also handle the double-encoded shapes we've seen.
    try:
        parsed = json.loads(s)
        if isinstance(parsed, str):
            parsed = json.loads(parsed)
    except (json.JSONDecodeError, TypeError):
        return False  # legacy comma-separated string still counts as filled
    return not parsed if isinstance(parsed, list) else False


def _pick_genres(doc: dict[str, Any]) -> list[str]:
    """Normalize + dedupe + drop broad/composite genres from a search doc."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in doc.get("genres") or []:
        if not raw or ";" in raw:
            # ;-joined dumps like 'Coming of Age; Epic; ...' aren't useful
            # as a single tag — skip rather than try to split.
            continue
        for sub in str(raw).split("|"):
            sub = sub.strip()
            if not sub or sub in _BROAD:
                continue
            norm = metrics_helper._normalise_tag(sub)
            if norm.lower() in seen:
                continue
            seen.add(norm.lower())
            out.append(norm)
        if len(out) >= 6:
            break
    return out


async def auto_tags_user(user_id: int) -> dict:
    """Auto-fill sub-genre tags for every book without any.

    Returns: {filled, no_hc_match, no_genres, skipped, total_untagged}.
    """
    conn = db.get_db()
    rows = conn.execute(
        """
        SELECT id, title, authors, tags
        FROM books
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchall()
    conn.close()
    candidates = [
        dict(r) for r in rows
        if _empty_tag_row(r["tags"])
    ]

    summary = {
        "filled": 0,
        "no_hc_match": 0,
        "no_genres": 0,
        "skipped": 0,
        "total_untagged": len(candidates),
    }
    if not candidates:
        return summary

    sem = asyncio.Semaphore(CONCURRENCY)
    results: list[tuple[int, list[str] | None]] = []

    async def process(book: dict) -> None:
        first_author = (book["authors"] or "").split(",", 1)[0].strip()
        async with sem:
            try:
                hits = await hardcover.search_books_rich(
                    f"{book['title']} {first_author}", per_page=3,
                )
            except Exception:
                log.exception("HC search failed: %s", book["title"])
                results.append((book["id"], None))
                return
            await asyncio.sleep(DELAY_BETWEEN)

        if not hits:
            results.append((book["id"], None))
            return

        # Pick first hit whose primary author overlaps with the seed.
        seed_tokens = _author_tokens(first_author)
        match: dict[str, Any] | None = None
        for h in hits:
            names = h.get("author_names") or []
            if not names:
                continue
            if not seed_tokens or seed_tokens & _author_tokens(names[0]):
                match = h
                break
        if match is None:
            # Fall back to the top hit anyway — better than nothing.
            match = hits[0]

        genres = _pick_genres(match)
        results.append((book["id"], genres or None))

    await asyncio.gather(*(process(b) for b in candidates))

    for book_id, tags in results:
        if tags is None:
            summary["no_hc_match"] += 1
            continue
        if not tags:
            summary["no_genres"] += 1
            continue
        try:
            db.update_book(book_id, user_id, {"tags": tags})
            summary["filled"] += 1
        except Exception:
            log.exception("update failed for book %d", book_id)
            summary["skipped"] += 1

    return summary
