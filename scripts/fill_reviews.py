#!/usr/bin/env python3
"""Backfill the `review` column on books from a StoryGraph CSV export.

Matches rows by normalized title + first-author last name (case
insensitive). Only fills books whose current `review` is NULL or
empty; never overwrites an existing user review.

Run inside the books-api container so `books` + DATA_DIR are
available:

    uv run python /app/scripts/fill_reviews.py \\
        --csv /app/data/storygraph_export.csv \\
        --user gordon

Default CSV path is /app/data/storygraph_export.csv (matches the
location the importer used). Pass `--dry-run` to preview matches
without writing.
"""

import argparse
import csv
import re
import sys

from books.helpers import db


def _norm_title(title: str) -> str:
    """Lowercase, strip articles + punctuation for forgiving compare."""
    t = (title or "").strip().lower()
    # Drop articles
    t = re.sub(r"^(the|a|an)\s+", "", t)
    # Strip punctuation, collapse whitespace
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _first_author_lastname(authors: str) -> str:
    """Last token of the first author, lowercased.

    StoryGraph exports authors as "First Last, Other Author" — so
    we split on comma and take the first item's last whitespace
    token.
    """
    if not authors:
        return ""
    first = authors.split(",")[0].strip()
    parts = first.split()
    if not parts:
        return ""
    return parts[-1].lower()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill book reviews from a StoryGraph CSV.",
    )
    parser.add_argument(
        "--csv",
        default="/app/data/storygraph_export.csv",
        help="Path to StoryGraph CSV export.",
    )
    parser.add_argument(
        "--user",
        default="gordon",
        help="Username whose library should be updated.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without writing.",
    )
    args = parser.parse_args()

    db.init_db()
    user = db.get_user_by_username(args.user)
    if not user:
        print(f"ERROR: user {args.user!r} not found")
        sys.exit(1)
    user_id = user["id"]

    # Index existing books by (norm_title, author_last) -> id.
    # Also keep a title-only fallback in case author parsing differs.
    conn = db.get_db()
    rows = conn.execute(
        "SELECT id, title, authors, review FROM books"
        " WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    by_title_author: dict[tuple[str, str], int] = {}
    by_title: dict[str, list[int]] = {}
    already_reviewed: set[int] = set()
    for r in rows:
        key = (_norm_title(r["title"]),
               _first_author_lastname(r["authors"] or ""))
        by_title_author[key] = r["id"]
        by_title.setdefault(_norm_title(r["title"]), []).append(r["id"])
        if (r["review"] or "").strip():
            already_reviewed.add(r["id"])
    conn.close()

    try:
        f = open(args.csv, encoding="utf-8")
    except OSError as exc:
        print(f"ERROR: cannot open CSV {args.csv!r}: {exc}")
        sys.exit(1)

    matched = filled = skipped_no_review = skipped_existing = unmatched = 0
    with f:
        reader = csv.DictReader(f)
        for row in reader:
            review = (row.get("Review") or "").strip()
            if not review:
                skipped_no_review += 1
                continue

            title = (row.get("Title") or "").strip()
            authors = (row.get("Authors") or "").strip()
            if not title:
                continue

            nt = _norm_title(title)
            la = _first_author_lastname(authors)
            book_id = by_title_author.get((nt, la))
            if book_id is None:
                # Fallback: unique title-only match
                candidates = by_title.get(nt) or []
                if len(candidates) == 1:
                    book_id = candidates[0]

            if book_id is None:
                unmatched += 1
                continue

            matched += 1
            if book_id in already_reviewed:
                skipped_existing += 1
                continue

            if args.dry_run:
                print(f"  (dry-run) would fill review for "
                      f"book {book_id}: {title[:60]}")
                filled += 1
                continue

            db.update_book(book_id, user_id, {"review": review})
            filled += 1

    print(
        f"\nDone: {filled} filled, {matched} matched, "
        f"{skipped_existing} skipped (already had review), "
        f"{skipped_no_review} CSV rows had no review, "
        f"{unmatched} CSV rows did not match any book."
    )


if __name__ == "__main__":
    main()
