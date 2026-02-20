"""Enrich existing library books and import unmatched reads from Goodreads.

Usage:
    python claude_enrich_from_goodreads.py                    # dry-run
    python claude_enrich_from_goodreads.py --commit           # write changes
    python claude_enrich_from_goodreads.py --enrich-only      # skip imports

Operates on user_id=1, connects directly to SQLite.
"""

import argparse
import csv
import json
import logging
import re
import sqlite3
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s: %(message)s",
)
log = logging.getLogger(__name__)

DB_PATH = Path("/data/containers/books/data/books.db")
GOODREADS_CSV = Path(
    "/home/andymac/Downloads/goodreads_library_export.csv"
)
USER_ID = 1

# --- Helpers ---


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def clean_isbn(raw: str) -> str:
    """Strip =\"...\" wrapping from Goodreads ISBN fields."""
    return raw.strip().strip('="').strip('"')


def normalize_title(title: str) -> str:
    """Lowercase, strip series suffix like (Series, #N)."""
    title = re.sub(r"\s*\(.*?#\d+\.?\d*\)\s*$", "", title)
    return title.lower().strip()


def parse_series_from_title(title: str) -> tuple[str | None, float | None]:
    """Extract series name and index from Goodreads title.

    Goodreads titles often look like:
        "Book Title (Series Name, #2)"
        "Book Title (Series Name, #1.5)"
    """
    m = re.search(r"\((.+?),\s*#(\d+\.?\d*)\)\s*$", title)
    if m:
        return m.group(1).strip(), float(m.group(2))
    return None, None


def clean_title(title: str) -> str:
    """Remove series suffix from title for storage."""
    return re.sub(r"\s*\(.*?#\d+\.?\d*\)\s*$", "", title).strip()


def make_sort_title(title: str) -> str:
    """Generate sort title, stripping leading articles."""
    lower = title.lower()
    for prefix in ("the ", "a ", "an "):
        if lower.startswith(prefix):
            return (
                title[len(prefix):]
                + ", "
                + title[: len(prefix) - 1]
            )
    return title


def make_author_sort(authors: str) -> str:
    """Convert 'First Last' to 'Last, First'."""
    parts = []
    for author in authors.split(","):
        author = author.strip()
        names = author.split()
        if len(names) > 1:
            parts.append(
                f"{names[-1]}, {' '.join(names[:-1])}"
            )
        else:
            parts.append(author)
    return " & ".join(parts)


def convert_date(date_str: str) -> str | None:
    """Convert YYYY/MM/DD to YYYY-MM-DD."""
    if not date_str or not date_str.strip():
        return None
    return date_str.strip().replace("/", "-")


def map_shelf_to_status(shelf: str) -> str:
    """Map Goodreads shelf to reading_status."""
    mapping = {
        "read": "read",
        "currently-reading": "reading",
        "to-read": "unread",
    }
    return mapping.get(shelf, "unread")


STATUS_RANK = {"unread": 0, "reading": 1, "read": 2}


def fuzzy_match(a: str, b: str) -> float:
    """Return similarity ratio between two strings."""
    return SequenceMatcher(None, a, b).ratio()


# --- Load data ---


def load_goodreads(path: Path) -> list[dict]:
    """Load and parse Goodreads CSV export."""
    rows = []
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    log.info("Loaded %d Goodreads entries", len(rows))
    return rows


def load_library_books(conn: sqlite3.Connection) -> list[dict]:
    """Load all books for USER_ID."""
    rows = conn.execute(
        "SELECT * FROM books WHERE user_id = ?",
        (USER_ID,),
    ).fetchall()
    books = [dict(r) for r in rows]
    log.info("Loaded %d library books", len(books))
    return books


# --- Matching ---


def build_match_index(
    library_books: list[dict],
) -> tuple[dict, dict, list[tuple[str, str, dict]]]:
    """Build lookup structures for matching.

    Returns:
        gr_id_map: goodreads_id -> book
        isbn_map: isbn -> book
        title_author_list: [(norm_title, norm_authors, book), ...]
    """
    gr_id_map = {}
    isbn_map = {}
    title_author_list = []

    for book in library_books:
        if book.get("goodreads_id"):
            gr_id_map[str(book["goodreads_id"])] = book
        if book.get("isbn"):
            isbn_map[book["isbn"]] = book
        norm_t = normalize_title(book["title"])
        norm_a = book["authors"].lower().strip()
        title_author_list.append((norm_t, norm_a, book))

    return gr_id_map, isbn_map, title_author_list


def find_match(
    gr_row: dict,
    gr_id_map: dict,
    isbn_map: dict,
    title_author_list: list[tuple[str, str, dict]],
) -> tuple[dict | None, str]:
    """Try to match a Goodreads row to a library book.

    Returns (matched_book, match_method) or (None, '').
    """
    gr_id = gr_row["Book Id"].strip()
    isbn = clean_isbn(gr_row["ISBN"])
    gr_title = gr_row["Title"].strip()
    gr_author = gr_row["Author"].strip()

    # 1. By goodreads_id
    if gr_id and gr_id in gr_id_map:
        return gr_id_map[gr_id], "goodreads_id"

    # 2. By ISBN
    if isbn and isbn in isbn_map:
        return isbn_map[isbn], "isbn"

    # 3. By normalized title + author
    norm_gr_title = normalize_title(gr_title)
    norm_gr_author = gr_author.lower().strip()

    best_match = None
    best_score = 0.0

    for norm_t, norm_a, book in title_author_list:
        title_sim = fuzzy_match(norm_gr_title, norm_t)
        # Author: check if GR author appears in library authors
        author_sim = fuzzy_match(norm_gr_author, norm_a)

        # Require high title match and reasonable author match
        if title_sim >= 0.85 and author_sim >= 0.6:
            combined = title_sim * 0.7 + author_sim * 0.3
            if combined > best_score:
                best_score = combined
                best_match = book

    if best_match and best_score >= 0.75:
        return best_match, "title_author"

    return None, ""


# --- Enrichment ---


def compute_enrichments(
    gr_row: dict, book: dict
) -> dict:
    """Compute fields to backfill from Goodreads into library book.

    Only fills NULL/empty fields. Never downgrades reading_status.
    """
    updates = {}
    gr_id = gr_row["Book Id"].strip()
    isbn = clean_isbn(gr_row["ISBN"])
    rating = int(gr_row["My Rating"])
    date_read = convert_date(gr_row["Date Read"])
    shelf = gr_row["Exclusive Shelf"].strip()
    gr_status = map_shelf_to_status(shelf)
    author_sort = gr_row["Author l-f"].strip()
    bookshelves = gr_row["Bookshelves"].strip()
    gr_title = gr_row["Title"].strip()

    # goodreads_id
    if gr_id and not book.get("goodreads_id"):
        updates["goodreads_id"] = gr_id

    # rating (skip 0 = unrated)
    if rating > 0 and not book.get("rating"):
        updates["rating"] = rating

    # date_finished
    if date_read and not book.get("date_finished"):
        updates["date_finished"] = date_read

    # reading_status: only upgrade, never downgrade
    current_rank = STATUS_RANK.get(
        book.get("reading_status", "unread"), 0
    )
    new_rank = STATUS_RANK.get(gr_status, 0)
    if new_rank > current_rank:
        updates["reading_status"] = gr_status

    # tags: merge
    if bookshelves:
        gr_tags = [
            t.strip()
            for t in bookshelves.split(",")
            if t.strip()
        ]
        existing_tags = book.get("tags")
        if isinstance(existing_tags, str):
            try:
                existing_tags = json.loads(existing_tags)
            except (json.JSONDecodeError, TypeError):
                existing_tags = []
        elif not existing_tags:
            existing_tags = []
        merged = list(
            dict.fromkeys(existing_tags + gr_tags)
        )
        if set(merged) != set(existing_tags):
            updates["tags"] = json.dumps(merged)

    # author_sort
    if author_sort and not book.get("author_sort"):
        updates["author_sort"] = author_sort

    # isbn
    if isbn and not book.get("isbn"):
        updates["isbn"] = isbn

    # published_date (prefer original publication year)
    pub_year = (
        gr_row.get("Original Publication Year", "").strip()
        or gr_row.get("Year Published", "").strip()
    )
    if pub_year and not book.get("published_date"):
        updates["published_date"] = pub_year

    # series / series_index from title
    series, series_index = parse_series_from_title(gr_title)
    if series and not book.get("series"):
        updates["series"] = series
    if series_index is not None and not book.get(
        "series_index"
    ):
        updates["series_index"] = series_index

    return updates


# --- Import ---


def build_new_book(gr_row: dict) -> dict:
    """Build a book record dict for inserting an unowned book."""
    gr_title = gr_row["Title"].strip()
    title = clean_title(gr_title)
    authors = gr_row["Author"].strip()
    additional = gr_row["Additional Authors"].strip()
    if additional:
        authors = f"{authors}, {additional}"

    series, series_index = parse_series_from_title(gr_title)
    isbn = clean_isbn(gr_row["ISBN"])
    rating = int(gr_row["My Rating"])
    date_read = convert_date(gr_row["Date Read"])
    date_added = convert_date(gr_row["Date Added"])
    bookshelves = gr_row["Bookshelves"].strip()
    author_sort_val = gr_row["Author l-f"].strip()

    tags = [
        t.strip()
        for t in bookshelves.split(",")
        if t.strip()
    ]

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    return {
        "user_id": USER_ID,
        "title": title,
        "sort_title": make_sort_title(title),
        "authors": authors,
        "author_sort": author_sort_val or make_author_sort(
            authors
        ),
        "series": series,
        "series_index": series_index,
        "description": None,
        "cover_filename": None,
        "file_path": None,
        "isbn": isbn or None,
        "goodreads_id": gr_row["Book Id"].strip(),
        "tags": json.dumps(tags) if tags else "[]",
        "date_added": date_added or now,
        "date_finished": date_read,
        "rating": rating if rating > 0 else None,
        "reading_status": "read",
        "progress": None,
        "is_favorite": 0,
        "is_owned": 0,
    }


def insert_new_book(
    conn: sqlite3.Connection, book_data: dict
) -> int:
    """Insert a new book record and return its id."""
    cursor = conn.execute(
        """INSERT INTO books (
            user_id, title, sort_title, authors, author_sort,
            series, series_index, description, cover_filename,
            file_path, isbn, goodreads_id, tags, date_added,
            date_finished, rating, reading_status,
            progress, is_favorite, is_owned
        ) VALUES (
            :user_id, :title, :sort_title, :authors,
            :author_sort, :series, :series_index,
            :description, :cover_filename, :file_path,
            :isbn, :goodreads_id, :tags, :date_added,
            :date_finished, :rating, :reading_status,
            :progress, :is_favorite, :is_owned
        )""",
        book_data,
    )
    return cursor.lastrowid


# --- Main ---


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Enrich library from Goodreads export"
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually write changes (default: dry-run)",
    )
    parser.add_argument(
        "--enrich-only",
        action="store_true",
        help="Only enrich existing books, skip imports",
    )
    parser.add_argument(
        "--published-date-only",
        action="store_true",
        help="Only backfill published_date, skip all other fields",
    )
    args = parser.parse_args()

    if not DB_PATH.exists():
        log.error("Database not found: %s", DB_PATH)
        return
    if not GOODREADS_CSV.exists():
        log.error("Goodreads CSV not found: %s", GOODREADS_CSV)
        return

    gr_rows = load_goodreads(GOODREADS_CSV)
    conn = get_db()
    library_books = load_library_books(conn)
    gr_id_map, isbn_map, ta_list = build_match_index(
        library_books
    )

    # Track results
    matched = []
    enriched = []
    unmatched_read = []
    unmatched_other = []

    for gr_row in gr_rows:
        book, method = find_match(
            gr_row, gr_id_map, isbn_map, ta_list
        )
        if book:
            updates = compute_enrichments(gr_row, book)
            if args.published_date_only:
                updates = {
                    k: v for k, v in updates.items()
                    if k == "published_date"
                }
            matched.append(
                (gr_row, book, method, updates)
            )
            if updates:
                enriched.append(
                    (gr_row, book, method, updates)
                )
        else:
            shelf = gr_row["Exclusive Shelf"].strip()
            if shelf == "read":
                unmatched_read.append(gr_row)
            else:
                unmatched_other.append(gr_row)

    # --- Report ---
    print(f"\n{'=' * 60}")
    print("GOODREADS IMPORT REPORT")
    print(f"{'=' * 60}")
    print(f"Goodreads entries: {len(gr_rows)}")
    print(f"Library books:     {len(library_books)}")
    print(f"Matched:           {len(matched)}")
    print(f"  - with updates:  {len(enriched)}")
    print(f"Unmatched (read):  {len(unmatched_read)}")
    print(f"Unmatched (other): {len(unmatched_other)}")
    print()

    # Show enrichment details
    if enriched:
        print(f"--- ENRICHMENTS ({len(enriched)}) ---")
        for gr_row, book, method, updates in enriched:
            print(
                f"  [{method}] "
                f"{book['title'][:50]}"
                f" <- {list(updates.keys())}"
            )
        print()

    # Show unmatched read books
    if unmatched_read:
        print(
            f"--- UNMATCHED READ BOOKS "
            f"({len(unmatched_read)}) ---"
        )
        for gr_row in unmatched_read:
            title = gr_row["Title"][:60]
            author = gr_row["Author"][:30]
            rating = gr_row["My Rating"]
            print(f"  {title} - {author} (rated {rating})")
        print()

    if not args.commit:
        print("DRY RUN - no changes written.")
        print("Run with --commit to apply changes.")
        conn.close()
        return

    # --- Apply enrichments ---
    enrich_count = 0
    for gr_row, book, method, updates in enriched:
        if not updates:
            continue
        sets = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values())
        values.append(book["id"])
        conn.execute(
            f"UPDATE books SET {sets} WHERE id = ?",
            values,
        )
        enrich_count += 1
    log.info("Enriched %d books", enrich_count)

    # --- Import unmatched read books ---
    import_count = 0
    skip_imports = args.enrich_only or args.published_date_only
    if not skip_imports and unmatched_read:
        for gr_row in unmatched_read:
            book_data = build_new_book(gr_row)
            new_id = insert_new_book(conn, book_data)
            import_count += 1
            log.info(
                "Imported: %s (id=%d)",
                book_data["title"][:50],
                new_id,
            )
    elif skip_imports:
        log.info("Skipping imports")

    conn.commit()
    conn.close()

    print(f"\nDONE: enriched {enrich_count}, "
          f"imported {import_count}")


if __name__ == "__main__":
    main()
