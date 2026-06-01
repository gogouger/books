#!/usr/bin/env python3
"""Backfill `books.asin` from the StoryGraph CSV export.

The original StoryGraph import (`import_storygraph.py`) stripped ASINs
because `_is_asin(book_uid)` flipped them to `isbn = None` — the script
had no place to store an Amazon ID. With the `asin` column added, we
re-walk the CSV and write any ASIN back to the matching book.

Matching:
  1. By ISBN if the book has one (rare — ASIN-only books typically
     don't, but be safe).
  2. By normalized title + first-author within the user's library.

Run inside the books-api container:

    uv run python /app/scripts/backfill_asins.py \
        --csv /app/data/storygraph_export.csv --user gordon
"""

from __future__ import annotations

import argparse
import csv
import re
import sys

from books.helpers import db, hardcover


ASIN_RE = re.compile(r"^B[0-9A-Z]{9}$")


def _first_author_norm(authors: str) -> str:
    if not authors:
        return ""
    return (
        authors.replace(" & ", ",")
        .replace(" and ", ",")
        .split(",")[0]
        .strip()
        .lower()
    )


def _is_asin(s: str) -> bool:
    return bool(ASIN_RE.match((s or "").strip().upper()))


def _candidate_books(conn, user_id: int) -> list[dict]:
    rows = conn.execute(
        """SELECT id, title, authors, isbn, asin
           FROM books
           WHERE user_id = ?""",
        (user_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def _find_book(
    asin_row: dict, books: list[dict],
) -> dict | None:
    row_isbn = (asin_row.get("isbn") or "").strip()
    title = asin_row["title"]
    authors = asin_row["authors"]
    # 1) ISBN match.
    if row_isbn:
        for b in books:
            if (b.get("isbn") or "").strip() == row_isbn:
                return b
    # 2) Normalized title + first-author match.
    nt = hardcover.normalize_title(title or "")
    na = _first_author_norm(authors or "")
    best = None
    best_score = 0.0
    for b in books:
        bnt = hardcover.normalize_title(b.get("title") or "")
        bna = _first_author_norm(b.get("authors") or "")
        if not bnt:
            continue
        score = hardcover._fuzzy_ratio(nt, bnt)
        if na and bna and na != bna:
            score *= 0.7
        if score > best_score:
            best_score = score
            best = b
    if best is not None and best_score >= 0.85:
        return best
    return None


def main() -> None:
    p = argparse.ArgumentParser(description="Backfill ASINs from StoryGraph CSV.")
    p.add_argument(
        "--csv",
        default="/app/data/storygraph_export.csv",
        help="Path to StoryGraph export CSV.",
    )
    p.add_argument("--user", default="gordon")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    db.init_db()
    user = db.get_user_by_username(args.user)
    if not user:
        print(f"ERROR: user {args.user!r} not found")
        sys.exit(1)
    uid = user["id"]

    conn = db.get_db()
    books = _candidate_books(conn, uid)

    with open(args.csv, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    asin_rows = []
    for r in rows:
        book_uid = (r.get("ISBN/UID") or "").strip()
        if _is_asin(book_uid):
            asin_rows.append({
                "title": (r.get("Title") or "").strip(),
                "authors": (r.get("Authors") or "").strip(),
                "asin": book_uid.upper(),
                # If StoryGraph stored an ISBN field elsewhere it'd
                # already be in books — _is_asin gates the UID.
                "isbn": None,
            })

    print(f"Found {len(asin_rows)} ASIN rows in the CSV.")

    filled = 0
    already = 0
    missed = 0
    for row in asin_rows:
        match = _find_book(row, books)
        if not match:
            missed += 1
            print(
                f"  ? could not match: {row['title']!r:50} "
                f"by {row['authors']!r}"
            )
            continue
        if (match.get("asin") or "").upper() == row["asin"]:
            already += 1
            continue
        if args.dry_run:
            print(
                f"  ? would fill {row['asin']} -> "
                f"{match['id']} {match['title'][:50]}"
            )
        else:
            # Raw SQL to avoid coupling with update_book's allowlist
            # (which may not include 'asin' until a redeploy lands).
            conn.execute(
                "UPDATE books SET asin = ? WHERE id = ? AND user_id = ?",
                (row["asin"], match["id"], uid),
            )
            conn.commit()
            print(
                f"  + {row['asin']} -> {match['id']} "
                f"{match['title'][:50]}"
            )
        filled += 1

    conn.close()
    print(
        f"\nDone: {len(asin_rows)} ASIN rows, "
        f"{filled} filled, {already} already set, {missed} unmatched."
    )


if __name__ == "__main__":
    main()
