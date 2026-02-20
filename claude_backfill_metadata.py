"""Backfill missing book metadata from Google Books API.

Finds books missing description, cover, or published_date and
queries Google Books to fill in the gaps. Rate limited to 1 req/s.

Usage:
    uv run python claude_backfill_metadata.py [--dry-run] [--limit N]
"""

import argparse
import hashlib
import logging
import sqlite3
import struct
import time
from pathlib import Path

import httpx
from decouple import config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

DATA_DIR = Path(config("BOOKS_DATA_DIR", default="/app/data"))
DB_PATH = DATA_DIR / "books.db"
COVERS_DIR = DATA_DIR / "covers"

GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes"
GOOGLE_BOOKS_API_KEY = config("GOOGLE_BOOKS_API_KEY", default="")

RATE_LIMIT_SECONDS = 1.0

# MD5 of Google Books "image not available" placeholder
PLACEHOLDER_HASH = "c96309220b9cbd205c36d879d09a3647"


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def get_books_needing_metadata(conn: sqlite3.Connection) -> list[dict]:
    """Find books missing description, cover, or published_date."""
    rows = conn.execute(
        """SELECT id, user_id, title, authors, isbn,
                  description, cover_filename, published_date
           FROM books
           WHERE (description IS NULL OR description = '')
              OR (cover_filename IS NULL OR cover_filename = '')
              OR (published_date IS NULL OR published_date = '')
           ORDER BY id"""
    ).fetchall()
    return [dict(r) for r in rows]


def search_google_books(
    client: httpx.Client, query: str, max_results: int = 3
) -> list[dict]:
    """Search Google Books API (synchronous)."""
    params: dict[str, str | int] = {
        "q": query,
        "maxResults": max_results,
    }
    if GOOGLE_BOOKS_API_KEY:
        params["key"] = GOOGLE_BOOKS_API_KEY

    resp = client.get(GOOGLE_BOOKS_URL, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    results = []
    for item in data.get("items", []):
        info = item.get("volumeInfo", {})
        identifiers = {
            i["type"]: i["identifier"]
            for i in info.get("industryIdentifiers", [])
        }
        results.append({
            "title": info.get("title", ""),
            "authors": ", ".join(info.get("authors", [])),
            "description": info.get("description", ""),
            "isbn": identifiers.get(
                "ISBN_13", identifiers.get("ISBN_10", "")
            ),
            "cover_url": info.get("imageLinks", {}).get(
                "thumbnail", ""
            ),
            "published_date": info.get("publishedDate", ""),
        })
    return results


def _image_dimensions(data: bytes) -> tuple[int | None, int | None]:
    """Extract width, height from PNG or JPEG data."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w = struct.unpack(">I", data[16:20])[0]
        h = struct.unpack(">I", data[20:24])[0]
        return w, h
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                break
            marker = data[i + 1]
            if marker == 0xD9:
                break
            if marker in (0xC0, 0xC1, 0xC2):
                h = struct.unpack(">H", data[i + 5 : i + 7])[0]
                w = struct.unpack(">H", data[i + 7 : i + 9])[0]
                return w, h
            length = struct.unpack(">H", data[i + 2 : i + 4])[0]
            i += 2 + length
    return None, None


def download_cover(
    client: httpx.Client, url: str, dest: Path
) -> bool:
    """Download a cover image. Returns True on success."""
    try:
        # Google Books thumbnail URLs use http; upgrade and
        # request larger image by replacing zoom parameter
        url = url.replace("http://", "https://")
        url = url.replace("zoom=1", "zoom=2")
        url = url.replace("&edge=curl", "")

        resp = client.get(url, timeout=15, follow_redirects=True)
        resp.raise_for_status()

        content_type = resp.headers.get("content-type", "")
        if "image" not in content_type:
            log.warning("Non-image response for cover: %s", content_type)
            return False

        if len(resp.content) < 1000:
            log.warning("Cover too small (%d bytes), skipping", len(resp.content))
            return False

        # Reject Google's "image not available" placeholder
        md5 = hashlib.md5(resp.content).hexdigest()
        if md5 == PLACEHOLDER_HASH:
            log.warning("Cover is 'image not available' placeholder")
            return False

        # Reject tiny images (banners/text snippets)
        w, h = _image_dimensions(resp.content)
        if h is not None and h < 150:
            log.warning("Cover too short (%dx%d), skipping", w, h)
            return False

        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(resp.content)
        return True
    except httpx.HTTPError:
        log.warning("Failed to download cover from %s", url)
        return False


def build_query(book: dict) -> str:
    """Build the best Google Books query for a book."""
    # If we have ISBN, search by that first - most precise
    if book["isbn"]:
        return f"isbn:{book['isbn']}"

    # Otherwise search by title + first author
    title = book["title"]
    authors = book["authors"]
    first_author = authors.split(",")[0].strip() if authors else ""

    if first_author and first_author != "Unknown":
        return f'intitle:"{title}" inauthor:"{first_author}"'
    return f'intitle:"{title}"'


def pick_best_result(
    book: dict, results: list[dict]
) -> dict | None:
    """Pick the best matching result from Google Books."""
    if not results:
        return None

    book_title = book["title"].lower().strip()
    book_author = (
        book["authors"].split(",")[0].strip().lower()
        if book["authors"] else ""
    )

    # Score each result
    scored = []
    for r in results:
        score = 0
        r_title = r["title"].lower().strip()
        r_authors = r["authors"].lower()

        # Title matching
        if r_title == book_title:
            score += 10
        elif book_title in r_title or r_title in book_title:
            score += 5

        # Author matching
        if book_author and book_author in r_authors:
            score += 5

        # Prefer results that have the data we need
        if r["description"]:
            score += 2
        if r["cover_url"]:
            score += 2
        if r["published_date"]:
            score += 1

        scored.append((score, r))

    scored.sort(key=lambda x: x[0], reverse=True)

    # Only return if we have at least some confidence
    best_score, best = scored[0]
    if best_score >= 5:
        return best

    # For ISBN searches, trust the first result
    if book["isbn"]:
        return results[0]

    log.debug(
        "No confident match for %r (best score: %d)",
        book["title"], best_score,
    )
    return None


def backfill_book(
    conn: sqlite3.Connection,
    client: httpx.Client,
    book: dict,
    dry_run: bool = False,
) -> dict:
    """Try to fill in missing metadata for one book.

    Returns a dict of what fields were updated.
    """
    needs_desc = not book["description"]
    needs_cover = not book["cover_filename"]
    needs_pubdate = not book["published_date"]

    query = build_query(book)
    results = search_google_books(client, query)

    # If ISBN search returned nothing, try title+author
    if not results and book["isbn"]:
        title = book["title"]
        first_author = (
            book["authors"].split(",")[0].strip()
            if book["authors"] else ""
        )
        if first_author and first_author != "Unknown":
            fallback_q = (
                f'intitle:"{title}" inauthor:"{first_author}"'
            )
        else:
            fallback_q = f'intitle:"{title}"'
        time.sleep(RATE_LIMIT_SECONDS)
        results = search_google_books(client, fallback_q)

    match = pick_best_result(book, results)
    if not match:
        return {}

    updates = {}

    if needs_desc and match["description"]:
        updates["description"] = match["description"]

    if needs_pubdate and match["published_date"]:
        updates["published_date"] = match["published_date"]

    # Download cover
    if needs_cover and match["cover_url"]:
        cover_filename = f"{book['id']}.jpg"
        cover_path = COVERS_DIR / str(book["user_id"]) / cover_filename
        if not dry_run:
            if download_cover(client, match["cover_url"], cover_path):
                updates["cover_filename"] = cover_filename
        else:
            updates["cover_filename"] = cover_filename

    # Fill in ISBN if we got one and didn't have one
    if not book["isbn"] and match["isbn"]:
        updates["isbn"] = match["isbn"]

    if updates and not dry_run:
        sets = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [book["id"]]
        conn.execute(
            f"UPDATE books SET {sets} WHERE id = ?", values
        )
        conn.commit()

    return updates


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill missing book metadata from Google Books"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Show what would be updated without changing anything",
    )
    parser.add_argument(
        "--limit", type=int, default=0,
        help="Max number of books to process (0 = all)",
    )
    args = parser.parse_args()

    if not GOOGLE_BOOKS_API_KEY:
        log.warning("No GOOGLE_BOOKS_API_KEY set, using unauthenticated API")

    conn = get_db()
    books = get_books_needing_metadata(conn)
    total = len(books)

    if args.limit:
        books = books[:args.limit]

    log.info(
        "Found %d books needing metadata%s",
        total,
        f" (processing first {args.limit})" if args.limit else "",
    )

    if args.dry_run:
        log.info("DRY RUN - no changes will be made")

    stats = {
        "processed": 0,
        "updated": 0,
        "no_match": 0,
        "errors": 0,
        "fields": {
            "description": 0,
            "cover_filename": 0,
            "published_date": 0,
            "isbn": 0,
        },
    }

    with httpx.Client() as client:
        for i, book in enumerate(books, 1):
            try:
                log.info(
                    "[%d/%d] %r by %s (id=%d)",
                    i, len(books),
                    book["title"], book["authors"], book["id"],
                )

                updates = backfill_book(
                    conn, client, book, dry_run=args.dry_run,
                )
                stats["processed"] += 1

                if updates:
                    stats["updated"] += 1
                    for field in updates:
                        if field in stats["fields"]:
                            stats["fields"][field] += 1
                    log.info(
                        "  -> Updated: %s",
                        ", ".join(updates.keys()),
                    )
                else:
                    stats["no_match"] += 1
                    log.info("  -> No match or no new data")

            except httpx.HTTPStatusError as e:
                stats["errors"] += 1
                if e.response.status_code == 429:
                    log.warning("Rate limited! Waiting 30s...")
                    time.sleep(30)
                else:
                    log.error(
                        "  -> HTTP error %d: %s",
                        e.response.status_code, e.response.text[:200],
                    )
            except Exception:
                stats["errors"] += 1
                log.exception("  -> Unexpected error")

            # Rate limit
            time.sleep(RATE_LIMIT_SECONDS)

    conn.close()

    log.info("--- Done ---")
    log.info("Processed: %d", stats["processed"])
    log.info("Updated:   %d", stats["updated"])
    log.info("No match:  %d", stats["no_match"])
    log.info("Errors:    %d", stats["errors"])
    log.info("Fields filled:")
    for field, count in stats["fields"].items():
        log.info("  %s: %d", field, count)


if __name__ == "__main__":
    main()
