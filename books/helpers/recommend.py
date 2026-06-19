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
import re

from . import db, hardcover

log = logging.getLogger(__name__)


# Reject Hardcover hits that are study guides / summaries / boxed sets /
# editorial variants. The book itself isn't a real read-this rec.
_NOISE_RE = re.compile(
    r"(?ix)"
    r"(^summary\s+of\b"
    r"|^summary\s+and\s+analysis\b"
    r"|\bconversation\s+starters\b"
    r"|\b(?:dramatized|illustrated|deluxe)\s+adaptation\b"
    r"|\b\d+\s+books?\s+collection\s+set\b"
    r"|\bboxed\s+set\b"
    r"|\bstudy\s+guide\b"
    r"|\bcliff(?:'s)?notes?\b"
    r"|\b\d+\s+of\s+\d+\b)"
)


def _is_noise_hit(title: str) -> bool:
    return bool(_NOISE_RE.search(title or ""))


def _author_tokens(name: str) -> set[str]:
    return {
        t for t in re.findall(r"[a-z]+", (name or "").lower())
        if len(t) >= 2
    }


# Caps tuned for the 100-req/15min Hardcover budget. A full rebuild does:
# - 1 author search per unique seed author (up to AUTHOR_CAP)
# - 1 title search per seed book (up to SEED_CAP)
# - 1 top-books-by-genre query per shared genre (up to GENRE_CAP)
AUTHOR_CAP = 10
SEED_CAP = 15
GENRE_CAP = 6
SLEEP_BETWEEN = 0.5  # seconds, polite spacing

# Genres on Hardcover that are too broad to anchor a "top in genre" row.
# These describe ~everything; including them would make Row 3 collapse to
# "top books overall" (a few Harry Potters and Ranger's Apprentices).
_BROAD_GENRES = frozenset({
    "Fiction", "Nonfiction", "Adult", "adult", "Audiobook",
    "Adventure", "Romance", "Young Adult", "Teen & Young Adult",
    "Young Adult Fiction", "Children's", "Picture Book",
    "Science Fiction & Fantasy",  # the whole bookstore section
    "Literature & Fiction",  # the other whole-bookstore section
    "Magic",  # too generic — every fantasy book is "magic"
    "Action & Adventure",
    "General", "Sci-fi",
    # Non-English variants leak through Hardcover's tags; treat as
    # broad rather than try to translate them.
    "Adulte", "Roman", "Fantastico", "Bambini",
    "Aventure", "Aventures", "Romanzo", "Ficción",
})


def _normalize_author(name: str) -> str:
    return (name or "").strip().lower()


def _loose_norm(title: str) -> str:
    """Like hardcover.normalize_title but does NOT split at the colon.

    Keeps the full title so 'Mistborn: The Final Empire' becomes
    'mistborn the final empire' instead of 'mistborn' — which is what
    we need for substring dedup against 'The Final Empire'.
    """
    if not title:
        return ""
    t = hardcover.strip_diacritics(title).lower().strip()
    t = re.sub(r"^(the|a|an)\s+", "", t)
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _existing_title_keys(user_id: int) -> tuple[set[str], set[str]]:
    """Return (normalized, loose) sets for existing-library dedup."""
    conn = db.get_db()
    rows = conn.execute(
        "SELECT title FROM books WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    conn.close()
    normalized = {hardcover.normalize_title(r["title"]) for r in rows}
    loose = {_loose_norm(r["title"]) for r in rows if r["title"]}
    return normalized, loose


def _existing_series_keys(user_id: int) -> set[str]:
    """Lowercase-stripped series names the user already has books in.

    Cross-edition dedup: 'Harry Potter and the Philosopher's Stone' (UK)
    and 'Harry Potter and the Sorcerer's Stone' (US) have different
    normalized titles but share the series name 'Harry Potter'. Same
    for 'Mistborn: The Final Empire' vs 'The Final Empire'. Comparing
    each candidate's series_names against this set catches both.
    """
    conn = db.get_db()
    rows = conn.execute(
        """
        SELECT DISTINCT COALESCE(b.series, sl.series_name) AS s
        FROM books b
        LEFT JOIN series_link sl ON sl.id = b.series_link_id
        WHERE b.user_id = ?
          AND COALESCE(b.series, sl.series_name) IS NOT NULL
        """,
        (user_id,),
    ).fetchall()
    conn.close()
    return {
        (r["s"] or "").strip().lower()
        for r in rows
        if r["s"]
    }


def gather_seeds(user_id: int) -> dict:
    """Tier signals: gold/silver/5★ books and series."""
    conn = db.get_db()
    book_rows = conn.execute(
        """
        SELECT id, title, authors, series, series_link_id,
               is_all_time_fav, is_second_fav, is_third_fav,
               rating, cover_filename
        FROM books
        WHERE user_id = ?
          AND (is_all_time_fav = 1
               OR is_second_fav = 1
               OR is_third_fav = 1
               OR rating = 5)
        ORDER BY is_all_time_fav DESC,
                 is_second_fav DESC,
                 is_third_fav DESC,
                 COALESCE(rating, 0) DESC
        """,
        (user_id,),
    ).fetchall()
    series_rows = conn.execute(
        """
        SELECT us.series_link_id, sl.series_name,
               us.rating,
               us.is_all_time_fav, us.is_second_fav, us.is_third_fav
        FROM user_series us
        JOIN series_link sl ON sl.id = us.series_link_id
        WHERE us.user_id = ?
          AND (us.is_all_time_fav = 1
               OR us.is_second_fav = 1
               OR us.is_third_fav = 1
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
            b_next.is_owned,
            b_next.rating,
            b_next.is_favorite
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
            (us.is_third_fav = 1) DESC,
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
            "rating": int(r["rating"]) if r["rating"] else 0,
            "is_favorite": bool(r["is_favorite"]),
            "why": f"Next in {r['series_name']}",
            "in_library_book_id": r["book_id"],
        })
    return results


async def more_from_loved_authors(
    user_id: int, dismissed: set[int]
) -> list[dict]:
    """Hardcover by-author search across gold/silver/5★ authors."""
    seeds = gather_seeds(user_id)
    # Unique-author map; pick the highest-tier book as the "why" anchor.
    # Skip seeds where the author is unknown — searching "Unknown" surfaces
    # ESV reprints and weird mislabelled-corpus hits, not useful recs.
    authors: dict[str, dict] = {}
    for b in seeds["books"]:
        for author in (b["authors"] or "").split(","):
            key = _normalize_author(author)
            if not key or key == "unknown":
                continue
            if key not in authors:
                authors[key] = {
                    "name": author.strip(),
                    "why_book": b["title"],
                }

    author_items = list(authors.values())[:AUTHOR_CAP]
    existing_norm, existing_loose = _existing_title_keys(user_id)
    existing_series = _existing_series_keys(user_id)

    recs: list[dict] = []
    seen_hc_ids: set[int] = set()

    for author in author_items:
        try:
            results = await hardcover.search_books_rich(
                author["name"], per_page=15,
            )
        except Exception:
            log.exception("HC author search failed: %s", author["name"])
            continue
        await asyncio.sleep(SLEEP_BETWEEN)

        seed_tokens = _author_tokens(author["name"])
        ranked = sorted(
            results, key=lambda h: -h.get("ratings_count", 0),
        )
        per_author_count = 0
        for hit in ranked:
            hc_id = int(hit.get("id") or 0)
            if not hc_id or hc_id in seen_hc_ids or hc_id in dismissed:
                continue

            # Skip omnibuses / collection sets / samplers — flagged by
            # Hardcover's compilation field. Saves the regex fallback.
            if hit.get("compilation"):
                continue

            # Match against the PRIMARY author only (author_names[0]).
            # Subset across the full list lets companion books like
            # "Stormlight World Guide" pass because Sanderson is in their
            # contributors list — but he didn't write them. The primary
            # author is the one we actually want to follow.
            names = hit.get("author_names") or []
            if not names:
                continue
            primary_tokens = _author_tokens(names[0])
            if not seed_tokens or not seed_tokens.issubset(primary_tokens):
                continue

            title = hit.get("title", "")
            if _is_noise_hit(title):
                continue

            # Companion/guide books often put the seed author's name IN
            # their own title ("...Brandon Sanderson's The Stormlight...").
            # If the seed author appears in the hit title, it's likely
            # not by them.
            title_lc_tokens = _author_tokens(title)
            if seed_tokens.issubset(title_lc_tokens):
                continue

            title_key = hardcover.normalize_title(title)
            if title_key in existing_norm:
                continue
            # Loose containment — handles "Mistborn: The Final Empire"
            # being a dup of the user's "The Final Empire" without the
            # colon-strip.
            loose = _loose_norm(title)
            if any(
                loose and ex and len(ex) > 4
                and (loose in ex or ex in loose)
                for ex in existing_loose
            ):
                continue
            # Series-name dedup: catches UK/US edition forks like
            # 'Philosopher's Stone' vs 'Sorcerer's Stone' that share a
            # series the user already owns books in.
            hit_series = {
                (s or "").strip().lower()
                for s in hit.get("series_names") or []
                if s
            }
            if hit_series and hit_series & existing_series:
                continue

            primary_author = ", ".join(names) or author["name"]

            seen_hc_ids.add(hc_id)
            recs.append({
                "kind": "loved_author",
                "hc_book_id": hc_id,
                "title": title,
                "authors": primary_author,
                "cover_url": hit.get("cover_url"),
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
    """Top books in the genres shared by your gold/silver/5★ seeds.

    Earlier versions of this row used a title-only Hardcover search per
    seed and tried to take the next-best hit. After same-author and
    in-library filtering it almost always returned zero — title-search
    just isn't the right primitive for genre-similar discovery.

    The new approach:
      1. For each seed, fetch its `genres` list from a single HC search.
      2. Score each non-generic genre by how many seeds it covers, then
         take the top few — "shared genre" is a stronger signal than
         "one seed mentioned it".
      3. For each top genre, query the `books` table filtered by
         `cached_tags _contains {Genre: [{tag: G}]}`, ordered by
         users_count desc. Hardcover's JSONB containment makes this a
         single GraphQL call per genre.
      4. Filter out: seed authors (Row 2 handles them), existing library
         titles, already-shown.
    """
    seeds = [
        s for s in gather_seeds(user_id)["books"][:SEED_CAP]
        if _normalize_author((s["authors"] or "").split(",")[0])
        not in ("", "unknown")
    ]
    if not seeds:
        return []

    existing_norm, existing_loose = _existing_title_keys(user_id)
    existing_series = _existing_series_keys(user_id)

    # Seed authors — anything by them surfaces in Row 2; don't double up.
    seed_author_tokens: set[str] = set()
    for s in seeds:
        for nm in (s["authors"] or "").split(","):
            seed_author_tokens |= _author_tokens(nm)

    # Step 1: pull each seed's genre list. One HC call per seed, capped.
    # Use the seed's title to find it on HC, then read the genres array.
    genre_to_seeds: dict[str, list[str]] = {}
    for seed in seeds:
        try:
            hits = await hardcover.search_books_rich(
                seed["title"], per_page=3,
            )
        except Exception:
            log.exception(
                "HC genre fetch failed for %s", seed["title"],
            )
            continue
        await asyncio.sleep(SLEEP_BETWEEN)

        # First hit whose primary author tokens overlap with seed's
        # author — guards against HC returning a different-author book
        # with the same title (the "Final Empire" by Kötke trap).
        seed_first_author_tokens = _author_tokens(
            (seed["authors"] or "").split(",")[0]
        )
        match_doc = None
        for h in hits:
            names = h.get("author_names") or []
            if not names:
                continue
            if not seed_first_author_tokens or seed_first_author_tokens.issubset(
                _author_tokens(names[0])
            ):
                match_doc = h
                break
        if not match_doc:
            continue

        # Hardcover's `genres` array is ordered roughly
        # most-specific-first; take the first 3 non-generic entries per
        # seed so a seed weighs three buckets rather than one. A handful
        # of genres are stored as `|`-joined compound strings ("Literature
        # & Fiction|Science Fiction & Fantasy") — split those out so each
        # half counts as its own bucket.
        kept = 0
        seed_genres: list[str] = []
        for g in match_doc.get("genres") or []:
            # Some `genres` entries are `;`-joined multi-genre dumps
            # ("Coming of Age; Epic; Action & Adventure; ..."). Treat
            # those as noise rather than try to split — the meaningful
            # genres usually appear earlier in the array anyway.
            if not g or ";" in g:
                continue
            for sub in g.split("|"):
                sub = sub.strip()
                if not sub or sub in _BROAD_GENRES:
                    continue
                seed_genres.append(sub)
        for g in seed_genres:
            bucket = genre_to_seeds.setdefault(g, [])
            if seed["title"] not in bucket:
                bucket.append(seed["title"])
            kept += 1
            if kept >= 3:
                break

    if not genre_to_seeds:
        return []

    # Step 2: pick the top-N genres by seed-coverage.
    top_genres = sorted(
        genre_to_seeds.keys(),
        key=lambda g: (-len(genre_to_seeds[g]), g),
    )[:GENRE_CAP]

    # Step 3: query top books per genre, filter, dedupe.
    seen_hc_ids: set[int] = set()
    recs: list[dict] = []

    for genre in top_genres:
        try:
            books = await hardcover.top_books_by_genre(genre, limit=12)
        except Exception:
            log.exception("HC top_books_by_genre failed: %s", genre)
            continue
        await asyncio.sleep(SLEEP_BETWEEN)

        anchor_seed = genre_to_seeds[genre][0]
        per_genre = 0
        for b in books:
            hc_id = b.get("id")
            if not hc_id or hc_id in seen_hc_ids or hc_id in dismissed:
                continue

            title = b.get("title", "")
            if _is_noise_hit(title):
                continue

            title_key = hardcover.normalize_title(title)
            if title_key in existing_norm:
                continue
            loose = _loose_norm(title)
            if any(
                loose and ex and len(ex) > 4
                and (loose in ex or ex in loose)
                for ex in existing_loose
            ):
                continue

            # Skip authors already represented in Row 2
            author_tokens = _author_tokens(b.get("primary_author", ""))
            if author_tokens and author_tokens.issubset(seed_author_tokens):
                continue

            # Series-name dedup — UK/US edition forks ("Philosopher's"
            # vs "Sorcerer's"), Mistborn omnibus, etc.
            hit_series = {
                (s or "").strip().lower()
                for s in b.get("series_names") or []
                if s
            }
            if hit_series and hit_series & existing_series:
                continue

            seen_hc_ids.add(hc_id)
            recs.append({
                "kind": "similar_to",
                "hc_book_id": hc_id,
                "title": title,
                "authors": b.get("primary_author") or "Unknown",
                "cover_url": b.get("cover_url"),
                "why": (
                    f"Top {genre} — you loved “{anchor_seed}”"
                ),
            })
            per_genre += 1
            if per_genre >= 3:
                break

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
