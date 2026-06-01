"""Backfill book tags from a StoryGraph CSV export.

StoryGraph's `Tags` column carries the only genre/topic data the user kept
in StoryGraph (mostly `theology` here). The category heuristic in
`db._derive_category` checks tags first, so populating them turns the
Religious bucket from a curated-author guess into a deterministic split.

Match strategy:
  1. ISBN (when CSV `ISBN/UID` is a real ISBN, not an ASIN).
  2. Title + first author (case-insensitive, whitespace-collapsed) as fallback
     so ASIN-only digital titles (Royal Road / KU / Audible) still match.

Tags are merged — existing tags are never dropped. Run with `--dry-run` to
preview changes.

Usage (inside the books-api container):
    python scripts/fill_tags_from_storygraph.py \\
        --csv /app/data/storygraph_export.csv --user gordon
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
from pathlib import Path


DEFAULT_CSV = "/app/data/storygraph_export.csv"
DEFAULT_DB = "/app/data/books.db"


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _is_isbn(uid: str) -> bool:
    """A real ISBN-10 or ISBN-13 — digits (and one trailing X allowed on ISBN-10).

    StoryGraph fills ASINs (e.g. ``B0CVD8D7H6``) in the same column; those
    aren't stored in `books.isbn` by the importer, so we skip them here.
    """
    if not uid:
        return False
    u = uid.strip().upper()
    if len(u) == 10:
        return bool(re.fullmatch(r"\d{9}[\dX]", u))
    if len(u) == 13:
        return u.isdigit()
    return False


def _first_author(authors: str) -> str:
    return _norm(authors.split(",")[0])


def _parse_tags(blob: str | None) -> list[str]:
    if not blob:
        return []
    try:
        v = json.loads(blob)
        return [str(t) for t in v] if isinstance(v, list) else []
    except Exception:
        return []


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--user", default="gordon")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    u = conn.execute(
        "SELECT id FROM users WHERE username = ?", (args.user,)
    ).fetchone()
    if not u:
        raise SystemExit(f"User {args.user!r} not found")
    user_id = u["id"]

    books = conn.execute(
        "SELECT id, title, authors, isbn, tags FROM books WHERE user_id = ?",
        (user_id,),
    ).fetchall()

    by_isbn: dict[str, sqlite3.Row] = {}
    by_ta: dict[tuple[str, str], sqlite3.Row] = {}
    for b in books:
        if b["isbn"]:
            by_isbn[b["isbn"].strip()] = b
        by_ta[(_norm(b["title"]), _first_author(b["authors"]))] = b

    csv_path = Path(args.csv)
    if not csv_path.exists():
        raise SystemExit(f"CSV not found: {csv_path}")

    rows_with_tags = 0
    matched = 0
    updated = 0
    no_match: list[str] = []

    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            raw_tags = (row.get("Tags") or "").strip()
            if not raw_tags:
                continue
            rows_with_tags += 1

            book = None
            uid = (row.get("ISBN/UID") or "").strip()
            if _is_isbn(uid) and uid in by_isbn:
                book = by_isbn[uid]
            if book is None:
                key = (
                    _norm(row.get("Title", "")),
                    _first_author(row.get("Authors", "")),
                )
                book = by_ta.get(key)
            if book is None:
                no_match.append(row.get("Title", "?"))
                continue
            matched += 1

            csv_tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
            existing = _parse_tags(book["tags"])
            existing_lower = {t.lower() for t in existing}
            new_tags = [t for t in csv_tags if t.lower() not in existing_lower]
            if not new_tags:
                continue

            merged = existing + new_tags
            if args.dry_run:
                updated += 1
                print(
                    f"  [dry] +{new_tags} -> {book['title']!r} "
                    f"(now {merged})"
                )
                continue

            conn.execute(
                "UPDATE books SET tags = ? WHERE id = ?",
                (json.dumps(merged), book["id"]),
            )
            updated += 1

    if not args.dry_run:
        conn.commit()
    conn.close()

    print(f"\nCSV rows with tags: {rows_with_tags}")
    print(f"Matched to a book:  {matched}")
    print(f"Updated:            {updated}")
    if no_match:
        print(f"\nUnmatched tagged rows ({len(no_match)}):")
        for t in no_match[:20]:
            print(f"  - {t}")
        if len(no_match) > 20:
            print(f"  ... and {len(no_match) - 20} more")


if __name__ == "__main__":
    main()
