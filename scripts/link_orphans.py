"""Link 14 known orphan books to their canonical series.

Some books slipped through `enrich_series.py` and the Hardcover sync —
Sanderson novellas (Edgedancer, Dawnshard, Mitosis), Skyward novellas
(Sunreach/ReDawn/Evershore), Dresden side stories, Hunger Games prequel,
etc. They live in the `books` table with NULL `series_link_id` even
though the parent series is already linked.

Each rule is `(author_substring, title_substring, series_name,
series_index)`. Matching is case-insensitive `contains`. The series must
already exist in `series_link` — we just resolve its id and set
`series_link_id` + `series_index` on the matching book(s).

Standalones (Elantris, Warbreaker, Tress, Yumi, Sunlit Man, Frugal
Wizard, Arcanum Unbounded, Isles of Emberdark) are intentionally NOT
linked — the plan defers the Cosmere super-series decision.

Run inside the books-api container:
    docker exec ggouger-books-api-1 sh -c \
      "cd /app && uv run python scripts/link_orphans.py --user gordon"

Flags:
  --dry-run   show what would change, write nothing
  --user      target username (default: gordon)
  --db        sqlite path (default: /app/data/books.db)
"""

from __future__ import annotations

import argparse
import sqlite3
import sys


# (author_substring, title_substring, series_name, series_index)
RULES: list[tuple[str, str, str, float]] = [
    # Stormlight novellas
    ("Sanderson", "Edgedancer", "The Stormlight Archive", 2.5),
    ("Sanderson", "Dawnshard", "The Stormlight Archive", 3.5),
    # Reckoners novella
    ("Sanderson", "Mitosis", "The Reckoners", 1.5),
    # Skyward novellas (co-authored with Janci Patterson)
    ("Patterson", "ReDawn", "Skyward", 2.5),
    ("Patterson", "Sunreach", "Skyward", 2.6),
    ("Patterson", "Evershore", "Skyward", 2.7),
    # Dresden Files side
    ("Butcher", "Side Jobs", "The Dresden Files", 12.5),
    ("Butcher", "Working for Bigfoot", "The Dresden Files", 11.5),
    ("Butcher", "Twelve Months", "The Dresden Files", 17.5),
    # Expanse novella
    ("Corey", "Drive", "The Expanse", 0.5),
    # WoT prequel
    ("Jordan", "Glimmers", "The Wheel of Time", 9.5),
    # Percy Jackson companion
    ("Riordan", "Demigod Files", "Percy Jackson and the Olympians", 4.5),
    # Hunger Games prequel
    ("Collins", "Sunrise on the Reaping", "The Hunger Games", 0.5),
    # Bobiverse novella
    ("Taylor", "Flybot", "Bobiverse", 5.5),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="gordon")
    ap.add_argument("--db", default="/app/data/books.db")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    user = conn.execute(
        "SELECT id FROM users WHERE username = ?", (args.user,)
    ).fetchone()
    if not user:
        print(f"ERROR: user {args.user!r} not found", file=sys.stderr)
        sys.exit(1)
    user_id = user["id"]

    linked = 0
    skipped_no_book = 0
    skipped_no_series = 0
    already = 0

    for author_sub, title_sub, series_name, series_index in RULES:
        series_row = conn.execute(
            "SELECT id FROM series_link WHERE series_name = ?",
            (series_name,),
        ).fetchone()
        if not series_row:
            print(
                f"  [skip] series_link missing for {series_name!r} "
                f"(needed for {title_sub!r})"
            )
            skipped_no_series += 1
            continue
        series_link_id = series_row["id"]

        books = conn.execute(
            """SELECT id, title, authors, series_link_id, series_index
               FROM books
               WHERE user_id = ?
                   AND authors LIKE ? COLLATE NOCASE
                   AND title LIKE ? COLLATE NOCASE""",
            (user_id, f"%{author_sub}%", f"%{title_sub}%"),
        ).fetchall()

        if not books:
            print(
                f"  [skip] no book matches author~{author_sub!r} "
                f"title~{title_sub!r}"
            )
            skipped_no_book += 1
            continue

        for b in books:
            if (
                b["series_link_id"] == series_link_id
                and b["series_index"] == series_index
            ):
                already += 1
                print(
                    f"  [ok ] #{b['id']} {b['title'][:40]!r} "
                    f"already at {series_name} #{series_index}"
                )
                continue
            action = "would link" if args.dry_run else "link"
            print(
                f"  [{action}] #{b['id']} {b['title'][:40]!r} -> "
                f"{series_name} #{series_index}"
            )
            if not args.dry_run:
                conn.execute(
                    """UPDATE books
                       SET series_link_id = ?, series_index = ?,
                           series = COALESCE(series, ?)
                       WHERE id = ?""",
                    (series_link_id, series_index, series_name, b["id"]),
                )
                linked += 1

    if not args.dry_run:
        conn.commit()
    conn.close()

    print(
        f"\nDone: linked {linked}, already-correct {already}, "
        f"skipped {skipped_no_book} (no matching book), "
        f"{skipped_no_series} (no matching series_link)"
    )


if __name__ == "__main__":
    main()
