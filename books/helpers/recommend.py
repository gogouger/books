"""Recommendation engine for the /recommendations page.

Three signal channels:
  1. next_in_series — pure DB. Series the user has started but not finished;
     surface the lowest-position unread book.
  2. more_from_loved_authors — Hardcover by-author search across every author
     who wrote a gold/silver/5★ book.
  3. similar_to_favorites — Hardcover title search seeded by each gold/silver/5★
     book. Hardcover's search ranks by combined title-and-popularity, so the
     non-seed results are usually genre-adjacent.

All three filter out books already in the user's library (by normalized title)
and books the user has explicitly dismissed.
"""

import asyncio
import logging

from . import db, hardcover

log = logging.getLogger(__name__)


# Caps tuned for the 100-req/15min Hardcover budget. A full rebuild does:
# - 1 author search per unique seed author (up to AUTHOR_CAP)
# - 1 title search per seed book (up to SEED_CAP)
# - 1 fetch_book_detail per resulting rec (for the cover) up to COVER_CAP
AUTHOR_CAP = 10
SEED_CAP = 15
COVER_CAP = 30
SLEEP_BETWEEN = 0.5  # seconds, polite spacing


def _normalize_author(name: str) -> str:
    return (name or "").strip().lower()


def _existing_title_keys(user_id: int) -> set[str]:
    conn = db.get_db()
    rows = conn.execute(
        "SELECT title FROM books WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    conn.close()
    return {hardcover.normalize_title(r["title"]) for r in rows}


def gather_seeds(user_id: int) -> dict:
    """Tier signals: gold/silver/5★ books and series."""
    conn = db.get_db()
    book_rows = conn.execute(
        """
        SELECT id, title, authors, series, series_link_id,
               is_all_time_fav, is_second_fav, rating, cover_filename
        FROM books
        WHERE user_id = ?
          AND (is_all_time_fav = 1
               OR is_second_fav = 1
               OR rating = 5)
        ORDER BY is_all_time_fav DESC,
                 is_second_fav DESC,
                 COALESCE(rating, 0) DESC
        """,
        (user_id,),
    ).fetchall()
    series_rows = conn.execute(
        """
        SELECT us.series_link_id, sl.series_name,
               us.rating, us.is_all_time_fav, us.is_second_fav
        FROM user_series us
        JOIN series_link sl ON sl.id = us.series_link_id
        WHERE us.user_id = ?
          AND (us.is_all_time_fav = 1
               OR us.is_second_fav = 1
               OR us.rating = 5)
        """,
        (user_id,),
    ).fetchall()
    conn.close()
    return {
        "books": [dict(r) for r in book_rows],
        "series": [dict(r) for r in series_rows],
    }


def next_in_series(user_id: int) -> list[dict]:
    """Next unread book per series the user has already started reading.

    'Started' = at least one book with reading_status in ('read', 'reading').
    Ranked by tier (gold ▸ silver ▸ rating ▸ name).
    """
    conn = db.get_db()
    rows = conn.execute(
        """
        SELECT
            us.series_link_id,
            sl.series_name,
            b_next.id AS book_id,
            b_next.title,
            b_next.authors,
            b_next.series_index,
            b_next.cover_filename,
            b_next.cover_updated_at,
            b_next.is_owned
        FROM user_series us
        JOIN series_link sl ON sl.id = us.series_link_id
        JOIN (
            -- Whole-number positions only: novellas / side stories live
            -- at fractional indices (1.1, 3.5) and the library already
            -- hides them. Surfacing them here would push "A War of Gifts"
            -- (Ender 1.1) ahead of the real next mainline book.
            SELECT b.series_link_id, MIN(b.series_index) AS min_idx
            FROM books b
            WHERE b.user_id = ?
              AND b.reading_status = 'unread'
              AND b.series_link_id IS NOT NULL
              AND b.series_index IS NOT NULL
              AND b.series_index >= 1
              AND b.series_index = CAST(b.series_index AS INTEGER)
            GROUP BY b.series_link_id
        ) nxt ON nxt.series_link_id = us.series_link_id
        JOIN books b_next
          ON b_next.user_id = ?
         AND b_next.series_link_id = nxt.series_link_id
         AND b_next.series_index = nxt.min_idx
         AND b_next.reading_status = 'unread'
        WHERE us.user_id = ?
          AND us.monitored = 1
          AND EXISTS (
            SELECT 1 FROM books b2
            WHERE b2.user_id = ?
              AND b2.series_link_id = us.series_link_id
              AND b2.reading_status IN ('read', 'reading')
          )
        ORDER BY
            (us.is_all_time_fav = 1) DESC,
            (us.is_second_fav = 1) DESC,
            COALESCE(us.rating, 0) DESC,
            sl.series_name
        LIMIT 24
        """,
        (user_id, user_id, user_id, user_id),
    ).fetchall()
    conn.close()

    results = []
    for r in rows:
        cover_url = None
        if r["cover_filename"]:
            cover_url = f"/covers/{user_id}/{r['cover_filename']}"
            if r["cover_updated_at"]:
                cover_url += f"?v={r['cover_updated_at']}"
        results.append({
            "kind": "next_in_series",
            "book_id": r["book_id"],
            "title": r["title"],
            "authors": r["authors"],
            "series": r["series_name"],
            "series_index": r["series_index"],
            "cover_url": cover_url,
            "is_owned": bool(r["is_owned"]),
            "why": f"Next in {r['series_name']}",
            "in_library_book_id": r["book_id"],
        })
    return results


async def more_from_loved_authors(
    user_id: int, dismissed: set[int]
) -> list[dict]:
    """Hardcover by-author search across gold/silver/5★ authors."""
    seeds = gather_seeds(user_id)
    # Unique-author map; pick the highest-tier book as the "why" anchor
    authors: dict[str, dict] = {}
    for b in seeds["books"]:
        for author in (b["authors"] or "").split(","):
            key = _normalize_author(author)
            if not key:
                continue
            if key not in authors:
                authors[key] = {
                    "name": author.strip(),
                    "why_book": b["title"],
                }

    author_items = list(authors.values())[:AUTHOR_CAP]
    existing_titles = _existing_title_keys(user_id)

    recs: list[dict] = []
    seen_hc_ids: set[int] = set()

    for author in author_items:
        try:
            results = await hardcover.search_books(
                f'"{author["name"]}"', per_page=10
            )
        except Exception:
            log.exception("HC author search failed: %s", author["name"])
            continue
        await asyncio.sleep(SLEEP_BETWEEN)

        per_author_count = 0
        for hit in results:
            hc_id = int(hit.get("id") or 0)
            if not hc_id or hc_id in seen_hc_ids or hc_id in dismissed:
                continue

            # Only books actually attributed to this author
            hit_author_key = _normalize_author(hit.get("author", ""))
            if hit_author_key != _normalize_author(author["name"]):
                continue

            title_key = hardcover.normalize_title(hit.get("title", ""))
            if title_key in existing_titles:
                continue

            seen_hc_ids.add(hc_id)
            recs.append({
                "kind": "loved_author",
                "hc_book_id": hc_id,
                "title": hit["title"],
                "authors": hit["author"],
                "cover_url": None,
                "why": (
                    f"By {author['name']}, who wrote "
                    f"“{author['why_book']}”"
                ),
            })
            per_author_count += 1
            if per_author_count >= 3:
                break  # cap per author so one author can't dominate

    return recs


async def similar_to_favorites(
    user_id: int, dismissed: set[int]
) -> list[dict]:
    """Hardcover title-search per gold/silver/5★ seed book.

    Search by title only (no author) so the hits skew toward
    genre-adjacent books rather than just other works by the same
    author (which Row 2 already handles).
    """
    seeds = gather_seeds(user_id)["books"][:SEED_CAP]
    if not seeds:
        return []

    existing_titles = _existing_title_keys(user_id)
    seen_hc_ids: set[int] = set()
    recs: list[dict] = []

    for seed in seeds:
        try:
            results = await hardcover.search_books(seed["title"], per_page=6)
        except Exception:
            log.exception("HC similar search failed: %s", seed["title"])
            continue
        await asyncio.sleep(SLEEP_BETWEEN)

        seed_norm = hardcover.normalize_title(seed["title"])
        seed_author_key = _normalize_author(
            (seed["authors"] or "").split(",")[0]
        )

        # Pick one non-seed, non-same-author hit per seed
        for hit in results:
            hc_id = int(hit.get("id") or 0)
            if not hc_id or hc_id in seen_hc_ids or hc_id in dismissed:
                continue

            hit_title_norm = hardcover.normalize_title(hit.get("title", ""))
            if hit_title_norm == seed_norm:
                continue
            if hit_title_norm in existing_titles:
                continue

            # Skip same-author hits — those belong in Row 2
            hit_author_key = _normalize_author(hit.get("author", ""))
            if seed_author_key and hit_author_key == seed_author_key:
                continue

            seen_hc_ids.add(hc_id)
            recs.append({
                "kind": "similar_to",
                "hc_book_id": hc_id,
                "title": hit["title"],
                "authors": hit["author"],
                "cover_url": None,
                "why": f"Because you loved “{seed['title']}”",
            })
            break  # one per seed for variety

    return recs


async def enrich_with_covers(recs: list[dict]) -> None:
    """Fetch Hardcover cover_url for recs missing one. Mutates in place."""
    needs = [
        r for r in recs
        if not r.get("cover_url") and r.get("hc_book_id")
    ][:COVER_CAP]
    for rec in needs:
        try:
            detail = await hardcover.fetch_book_detail(rec["hc_book_id"])
            if detail and detail.get("cover_url"):
                rec["cover_url"] = detail["cover_url"]
            await asyncio.sleep(0.3)
        except Exception:
            log.exception(
                "cover fetch failed hc_book_id=%s",
                rec.get("hc_book_id"),
            )
