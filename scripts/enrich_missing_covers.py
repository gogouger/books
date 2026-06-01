#!/usr/bin/env python3
"""Fill in missing covers for books by searching external sources.

For each book with `cover_filename IS NULL`, try in order:
  1. Open Library search by title + author (cover_i -> covers.openlibrary.org)
  2. Google Books search by title + author (volumeInfo.imageLinks)
  3. Apple Books / iTunes search (artworkUrl100 upscaled to 1500x1500)

On success, writes the JPEG to DATA_DIR/covers/<user_id>/<book_id>.jpg
and updates `cover_filename` + `cover_updated_at` in the DB.

Run inside the books-api container:

    uv run python /app/scripts/enrich_missing_covers.py \\
        --user gordon

Pass `--limit N` to cap the number of books processed, `--dry-run`
to skip writes, `--user all` to walk every non-archive user.
"""

import argparse
import sys
import time
from datetime import datetime, timezone

import httpx

from books.helpers import db


USER_AGENT = "meron-books-bot/1.0 gordon@ggouger.com"
OL_SEARCH = "https://openlibrary.org/search.json"
OL_COVER = "https://covers.openlibrary.org/b/id/{cover_id}-L.jpg"
GBOOKS = "https://www.googleapis.com/books/v1/volumes"
ITUNES_SEARCH = "https://itunes.apple.com/search"

# Title-similarity floor for Apple Books matches. Lower than 0.5 lets
# in too many wrong matches (e.g. iTunes returns unrelated titles for
# generic queries); 0.6 keeps it strict.
_APPLE_TITLE_THRESHOLD = 0.6


def _first_author(authors: str) -> str:
    """Return the first author, splitting on comma / ampersand / 'and'."""
    if not authors:
        return ""
    parts = (
        authors.replace(" & ", ",")
        .replace(" and ", ",")
        .split(",")
    )
    return parts[0].strip()


def _try_openlibrary(
    title: str, authors: str, client: httpx.Client,
) -> bytes | None:
    """Search OpenLibrary by title+author, fetch the first cover."""
    if not title:
        return None
    params = {"title": title, "limit": 1}
    first = _first_author(authors)
    if first:
        params["author"] = first
    try:
        r = client.get(OL_SEARCH, params=params)
        if r.status_code != 200:
            return None
        docs = (r.json() or {}).get("docs") or []
        if not docs:
            return None
        cover_id = docs[0].get("cover_i")
        if not cover_id:
            return None
        cr = client.get(
            OL_COVER.format(cover_id=cover_id),
            params={"default": "false"},
        )
        if (
            cr.status_code == 200
            and len(cr.content) > 1500
            and cr.headers.get("content-type", "").startswith("image")
        ):
            return cr.content
    except Exception:
        return None
    return None


def _norm_title(s: str) -> str:
    """Lowercase and strip non-alnum for fuzzy comparisons."""
    return "".join(ch for ch in s.lower() if ch.isalnum() or ch.isspace()).strip()


def _title_similarity(a: str, b: str) -> float:
    """Cheap token-overlap ratio. 1.0 == identical, 0.0 == disjoint."""
    aa, bb = _norm_title(a), _norm_title(b)
    if not aa or not bb:
        return 0.0
    ta, tb = set(aa.split()), set(bb.split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(len(ta), len(tb))


def _try_apple_books(
    title: str, authors: str, client: httpx.Client,
) -> bytes | None:
    """Apple Books search fallback. Returns a high-res JPEG or None."""
    if not title:
        return None
    first = _first_author(authors)
    term = f"{title} {first}".strip()
    params = {
        "term": term,
        "entity": "ebook",
        "limit": 5,
        "country": "US",
    }
    try:
        r = client.get(ITUNES_SEARCH, params=params)
        if r.status_code != 200:
            return None
        results = (r.json() or {}).get("results") or []
        if not results:
            return None
        # Pick the best title match above the threshold.
        scored: list[tuple[float, dict]] = []
        for item in results:
            res_title = item.get("trackName") or item.get("collectionName") or ""
            sim = _title_similarity(res_title, title)
            scored.append((sim, item))
        scored.sort(key=lambda t: t[0], reverse=True)
        best_sim, best = scored[0]
        if best_sim < _APPLE_TITLE_THRESHOLD:
            return None
        artwork = best.get("artworkUrl100") or best.get("artworkUrl60")
        if not artwork:
            return None
        # iTunes serves 100x100; swap for a high-res 1500x1500 variant.
        hires = artwork.replace("100x100bb", "1500x1500bb")
        hires = hires.replace("100x100", "1500x1500")
        ir = client.get(hires)
        if ir.status_code == 200 and len(ir.content) > 1500:
            return ir.content
        # Fall back to the original size if the upscale isn't there.
        orig = client.get(artwork)
        if orig.status_code == 200 and len(orig.content) > 1500:
            return orig.content
    except Exception:
        return None
    return None


def _try_google_books(
    title: str, authors: str, client: httpx.Client,
) -> bytes | None:
    """Google Books fallback when OpenLibrary has no cover."""
    if not title:
        return None
    q = f"intitle:{title}"
    first = _first_author(authors)
    if first:
        q += f"+inauthor:{first}"
    try:
        r = client.get(
            GBOOKS,
            params={"q": q, "maxResults": 1, "country": "US"},
        )
        if r.status_code != 200:
            return None
        items = (r.json() or {}).get("items") or []
        if not items:
            return None
        links = items[0].get("volumeInfo", {}).get("imageLinks") or {}
        url = links.get("thumbnail") or links.get("smallThumbnail")
        if not url:
            return None
        # Google serves HTTP by default; upgrade and request a larger
        # image while we're at it.
        url = url.replace("http://", "https://")
        url = url.replace("&edge=curl", "")
        ir = client.get(url)
        if ir.status_code == 200 and len(ir.content) > 1000:
            return ir.content
    except Exception:
        return None
    return None


def _missing_books_for(user_id: int) -> list[dict]:
    conn = db.get_db()
    rows = conn.execute(
        """SELECT id, user_id, title, authors
           FROM books
           WHERE user_id = ? AND cover_filename IS NULL""",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _all_user_ids() -> list[int]:
    """Every user except the archive user (system-managed)."""
    conn = db.get_db()
    rows = conn.execute(
        "SELECT id FROM users WHERE username <> 'archive'"
        " ORDER BY id"
    ).fetchall()
    conn.close()
    return [r["id"] for r in rows]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fill missing book covers via OpenLibrary + Google Books.",
    )
    parser.add_argument(
        "--user",
        default="gordon",
        help="Username to enrich, or 'all' to walk every user.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Cap the number of books processed (0 = no cap).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Don't write covers or DB updates.",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.4,
        help="Seconds to sleep between books (politeness).",
    )
    args = parser.parse_args()

    db.init_db()

    if args.user == "all":
        user_ids = _all_user_ids()
    else:
        user = db.get_user_by_username(args.user)
        if not user:
            print(f"ERROR: user {args.user!r} not found")
            sys.exit(1)
        user_ids = [user["id"]]

    total_filled_ol = 0
    total_filled_gb = 0
    total_filled_apple = 0
    total_processed = 0
    total_failed = 0

    with httpx.Client(
        follow_redirects=True,
        timeout=20,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        for uid in user_ids:
            books = _missing_books_for(uid)
            if not books:
                continue
            covers_dir = db.DATA_DIR / "covers" / str(uid)
            if not args.dry_run:
                covers_dir.mkdir(parents=True, exist_ok=True)

            for book in books:
                if args.limit and total_processed >= args.limit:
                    break
                total_processed += 1
                title = book["title"] or ""
                authors = book["authors"] or ""

                source = None
                cover = _try_openlibrary(title, authors, client)
                if cover:
                    source = "openlibrary"
                else:
                    time.sleep(args.sleep)
                    cover = _try_google_books(title, authors, client)
                    if cover:
                        source = "google"
                if not cover:
                    # Polite second-source sleep before Apple.
                    time.sleep(max(args.sleep, 1.0))
                    cover = _try_apple_books(title, authors, client)
                    if cover:
                        source = "apple"

                if not cover:
                    total_failed += 1
                    print(f"  - {book['id']:>5} {title[:50]:50s} "
                          f"(no cover found)")
                    time.sleep(args.sleep)
                    continue

                if args.dry_run:
                    print(f"  ? {book['id']:>5} {title[:50]:50s} "
                          f"would fill from {source}")
                else:
                    cover_path = covers_dir / f"{book['id']}.jpg"
                    cover_path.write_bytes(cover)
                    db.update_book(
                        book["id"], uid,
                        {
                            "cover_filename": f"{book['id']}.jpg",
                            "cover_updated_at": datetime.now(
                                timezone.utc
                            ).isoformat(),
                        },
                    )
                    print(f"  + {book['id']:>5} {title[:50]:50s} "
                          f"filled from {source}")

                if source == "openlibrary":
                    total_filled_ol += 1
                elif source == "google":
                    total_filled_gb += 1
                else:
                    total_filled_apple += 1

                time.sleep(args.sleep)

            if args.limit and total_processed >= args.limit:
                break

    total_filled = (
        total_filled_ol + total_filled_gb + total_filled_apple
    )
    print(
        f"\nDone: processed {total_processed}, "
        f"filled {total_filled} ("
        f"{total_filled_ol} OpenLibrary, "
        f"{total_filled_gb} Google Books, "
        f"{total_filled_apple} Apple Books), "
        f"{total_failed} unresolved."
    )


if __name__ == "__main__":
    main()
