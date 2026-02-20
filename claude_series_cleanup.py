"""Comprehensive series cleanup: merge duplicates and refresh HC data.

Phase 1: Merge name-variant duplicate series_link pairs and
         single-book orphans into their HC-linked counterparts.
Phase 2: Re-scan all HC-linked series with stale entries.
Phase 3: Search HC for unlinked series with 2+ books.

Usage:
    uv run python claude_series_cleanup.py            # dry-run
    uv run python claude_series_cleanup.py --commit   # write changes
"""

import argparse
import asyncio
import re
import sqlite3
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, ".")

from books.helpers import db, hardcover  # noqa: E402

DB_PATH = Path("/data/containers/books/data/books.db")
USER_ID = 1

STATUS_RANK = {"unread": 0, "reading": 1, "read": 2}

# --- Merge pairs: (primary_link_id, orphan_link_id) ---

MERGE_PAIRS = [
    (47, 268),   # Heroes Of Dune <- Heroes of Dune
    (114, 244),  # Xeelee Sequence <- Xelee Sequence
    (18, 271),   # Asian Saga: Chronological Order <- Asian Saga
    (90, 257),   # Narnia (Chronological) <- Narnia (Publication)
    (97, 264),   # The Mistborn Saga <- Mistborn
    (94, 266),   # The Foreworld Saga <- Foreworld
    (79, 226),   # Robot <- Robot, chronological order
    (36, 212),   # Dune <- Dune Universe
    (127, 195),  # The Baroque Cycle <- The Baroque Cycle (8 volume)
]


# --- Title normalization (from hardcover.py) ---

_ROMAN_MAP = {
    "i": "1", "ii": "2", "iii": "3", "iv": "4",
    "v": "5", "vi": "6", "vii": "7", "viii": "8",
    "ix": "9", "x": "10", "xi": "11", "xii": "12",
    "xiii": "13", "xiv": "14", "xv": "15", "xvi": "16",
    "xvii": "17", "xviii": "18", "xix": "19", "xx": "20",
}


def _roman_to_arabic(match: re.Match) -> str:
    word = match.group(0).lower()
    return _ROMAN_MAP.get(word, word)


def normalize_title(title: str) -> str:
    """Normalize a title for comparison."""
    title = unicodedata.normalize("NFKD", title)
    title = "".join(
        c for c in title if not unicodedata.combining(c)
    )
    title = re.split(r"[:\u2014]|\s-\s", title)[0]
    title = title.strip().lower()
    title = re.sub(r"\s+part\s+\d+(\s+of\s+\d+)?$", "", title)
    title = re.sub(r"\s+vol(ume)?\.?\s+\d+$", "", title)
    title = re.sub(r"^(the|a|an)\s+", "", title)
    title = title.replace("-", " ")
    title = re.sub(r"[^a-z0-9\s]", "", title)
    title = re.sub(r"\s+", " ", title).strip()
    roman_pattern = r"\b(" + "|".join(_ROMAN_MAP.keys()) + r")\b"
    title = re.sub(roman_pattern, _roman_to_arabic, title)
    return title


def match_orphan_to_primary(
    orphan: dict,
    primary_books: list[dict],
    matched_ids: set[int],
) -> dict | None:
    """Match an orphan book to a primary book (3-tier)."""
    candidates = [
        b for b in primary_books if b["id"] not in matched_ids
    ]
    if not candidates:
        return None

    orphan_index = orphan.get("series_index")
    orphan_norm = normalize_title(orphan["title"])

    # Tier 1: exact series_index
    if orphan_index is not None:
        for pb in candidates:
            if pb.get("series_index") == orphan_index:
                return pb

    # Tier 2: normalized title
    for pb in candidates:
        if normalize_title(pb["title"]) == orphan_norm:
            return pb

    # Tier 3: fuzzy title (ratio > 0.80)
    best_score = 0.0
    best_match = None
    for pb in candidates:
        score = SequenceMatcher(
            None, orphan_norm, normalize_title(pb["title"])
        ).ratio()
        if score > best_score:
            best_score = score
            best_match = pb
    if best_score > 0.80 and best_match:
        return best_match

    return None


def compute_transfers(orphan: dict, primary: dict) -> dict:
    """Compute upgrade-only flag transfers."""
    updates = {}
    if orphan.get("is_owned") and not primary.get("is_owned"):
        updates["is_owned"] = 1
    orphan_rank = STATUS_RANK.get(
        orphan.get("reading_status", "unread"), 0
    )
    primary_rank = STATUS_RANK.get(
        primary.get("reading_status", "unread"), 0
    )
    if orphan_rank > primary_rank:
        updates["reading_status"] = orphan["reading_status"]
    for field in (
        "rating", "date_finished", "file_path", "cover_filename",
    ):
        if orphan.get(field) and not primary.get(field):
            updates[field] = orphan[field]
    return updates


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# --- Phase 1: Merge name-variant duplicates ---


def phase1_merge(conn: sqlite3.Connection, commit: bool) -> None:
    """Merge name-variant duplicate pairs."""
    print(f"\n{'=' * 60}")
    print("PHASE 1: MERGE NAME-VARIANT DUPLICATES")
    print(f"{'=' * 60}\n")

    total_transfers = 0
    total_moves = 0
    total_deletes = 0
    total_link_deletes = 0

    for primary_id, orphan_id in MERGE_PAIRS:
        primary_link = conn.execute(
            "SELECT * FROM series_link WHERE id = ?",
            (primary_id,),
        ).fetchone()
        orphan_link = conn.execute(
            "SELECT * FROM series_link WHERE id = ?",
            (orphan_id,),
        ).fetchone()

        if not primary_link or not orphan_link:
            pname = primary_link["series_name"] if primary_link else "?"
            oname = orphan_link["series_name"] if orphan_link else "?"
            print(
                f"  SKIP: link {primary_id} ({pname})"
                f" or {orphan_id} ({oname}) not found"
            )
            continue

        pname = primary_link["series_name"]
        oname = orphan_link["series_name"]

        primary_books = [
            dict(r) for r in conn.execute(
                "SELECT * FROM books WHERE series_link_id = ?",
                (primary_id,),
            ).fetchall()
        ]
        orphan_books = [
            dict(r) for r in conn.execute(
                "SELECT * FROM books WHERE series_link_id = ?",
                (orphan_id,),
            ).fetchall()
        ]

        print(f"--- {pname} <- {oname} ---")
        print(
            f"  Primary: link={primary_id}"
            f" ({len(primary_books)} books)"
        )
        print(
            f"  Orphan:  link={orphan_id}"
            f" ({len(orphan_books)} books)"
        )

        matched_primary_ids: set[int] = set()
        transfers = []
        moves = []
        deletes = []

        for ob in orphan_books:
            match = match_orphan_to_primary(
                ob, primary_books, matched_primary_ids
            )

            if match:
                matched_primary_ids.add(match["id"])
                updates = compute_transfers(ob, match)

                if updates:
                    transfers.append((match["id"], updates))
                    flag_str = ", ".join(
                        f"{k}={v}" for k, v in updates.items()
                    )
                    print(
                        f"    TRANSFER: #{ob['id']}"
                        f" -> #{match['id']}"
                        f" [{flag_str}]"
                        f"  {ob['title'][:50]}"
                    )
                else:
                    print(
                        f"    DUPLICATE: #{ob['id']}"
                        f" = #{match['id']}"
                        f"  {ob['title'][:50]}"
                    )
                deletes.append(ob["id"])
            else:
                moves.append((ob["id"], ob["title"]))
                print(
                    f"    MOVE: #{ob['id']}"
                    f" -> link {primary_id}"
                    f"  {ob['title'][:50]}"
                )

        if commit:
            for pid, updates in transfers:
                sets = ", ".join(f"{k} = ?" for k in updates)
                values = list(updates.values()) + [pid]
                conn.execute(
                    f"UPDATE books SET {sets} WHERE id = ?",
                    values,
                )

            for book_id, _title in moves:
                conn.execute(
                    "UPDATE books SET series_link_id = ?,"
                    " series = ? WHERE id = ?",
                    (primary_id, pname, book_id),
                )

            for book_id in deletes:
                conn.execute(
                    "DELETE FROM books WHERE id = ?",
                    (book_id,),
                )

            conn.execute(
                "DELETE FROM series_link WHERE id = ?",
                (orphan_id,),
            )

        total_transfers += len(transfers)
        total_moves += len(moves)
        total_deletes += len(deletes)
        total_link_deletes += 1
        print()

    print(
        f"Phase 1 totals: {total_transfers} transfers,"
        f" {total_moves} moves,"
        f" {total_deletes} deletes,"
        f" {total_link_deletes} links removed"
    )


# --- Phase 2: Re-scan stale HC-linked series ---


async def phase2_rescan(
    conn: sqlite3.Connection, commit: bool
) -> None:
    """Re-scan HC-linked series where lib_books != entries."""
    print(f"\n{'=' * 60}")
    print("PHASE 2: RE-SCAN STALE HC-LINKED SERIES")
    print(f"{'=' * 60}\n")

    stale = conn.execute(
        """SELECT sl.id, sl.series_name,
                  sl.hardcover_series_id, sl.hardcover_series_name,
                  (SELECT COUNT(*) FROM books b
                   WHERE b.series_link_id = sl.id) as lib_books,
                  (SELECT COUNT(*) FROM series_entries se
                   WHERE se.series_link_id = sl.id) as entries
           FROM series_link sl
           WHERE sl.hardcover_series_id IS NOT NULL
             AND (SELECT COUNT(*) FROM books b
                  WHERE b.series_link_id = sl.id) !=
                 (SELECT COUNT(*) FROM series_entries se
                  WHERE se.series_link_id = sl.id)
           ORDER BY sl.series_name"""
    ).fetchall()

    if not stale:
        print("  No stale series found.\n")
        return

    print(f"  Found {len(stale)} series to re-scan\n")

    for row in stale:
        sl_id = row["id"]
        name = row["series_name"]
        hc_id = row["hardcover_series_id"]
        print(
            f"  {name} (link={sl_id}, HC={hc_id},"
            f" {row['lib_books']} books,"
            f" {row['entries']} entries)"
        )

        try:
            raw_books = await hardcover.fetch_series_books(hc_id)
            if not raw_books:
                print("    No books returned from HC")
                continue

            data_hash = hardcover.compute_data_hash(raw_books)
            deduped = hardcover.dedup_series_books(raw_books)
            library_books = db.get_series_books(USER_ID, sl_id)
            entries = hardcover.match_books(deduped, library_books)

            linked = sum(
                1 for e in entries if e["status"] == "linked"
            )
            unlinked = sum(
                1 for e in entries if e["status"] == "unlinked"
            )
            print(
                f"    {len(deduped)} positions:"
                f" {linked} linked, {unlinked} unlinked"
            )

            if commit:
                db.link_series(
                    USER_ID, sl_id, hc_id,
                    row["hardcover_series_name"],
                    data_hash=data_hash,
                )
                db.store_hc_series_books(sl_id, raw_books)
                db.upsert_series_entries(
                    sl_id, entries,
                    user_id=USER_ID, series_name=name,
                )

        except Exception as exc:
            print(f"    ERROR: {exc}")

    print()


# --- Phase 3: Search HC for unlinked multi-book series ---


async def phase3_search(
    conn: sqlite3.Connection, commit: bool
) -> None:
    """Search HC for unlinked series with 2+ books."""
    print(f"\n{'=' * 60}")
    print("PHASE 3: SEARCH HC FOR UNLINKED SERIES")
    print(f"{'=' * 60}\n")

    unlinked = conn.execute(
        """SELECT sl.id, sl.series_name,
                  (SELECT COUNT(*) FROM books b
                   WHERE b.series_link_id = sl.id) as lib_books
           FROM series_link sl
           WHERE sl.hardcover_series_id IS NULL
             AND (SELECT COUNT(*) FROM books b
                  WHERE b.series_link_id = sl.id) >= 2
           ORDER BY sl.series_name"""
    ).fetchall()

    if not unlinked:
        print("  No unlinked multi-book series found.\n")
        return

    print(f"  Found {len(unlinked)} unlinked series\n")

    matched_count = 0
    for row in unlinked:
        sl_id = row["id"]
        name = row["series_name"]
        print(f"  {name} (link={sl_id}, {row['lib_books']} books)")

        try:
            results = await hardcover.search_series(name)
            best = hardcover.pick_best_series(name, results)
            if not best:
                print("    No HC match found")
                continue

            hc_id = best["id"]
            hc_name = best["name"]
            print(
                f"    HC match: {hc_name}"
                f" (id={hc_id}, {best['books_count']} books)"
            )

            raw_books = await hardcover.fetch_series_books(hc_id)
            if not raw_books:
                print("    No books returned from HC")
                continue

            data_hash = hardcover.compute_data_hash(raw_books)
            deduped = hardcover.dedup_series_books(raw_books)
            library_books = db.get_series_books(USER_ID, sl_id)
            entries = hardcover.match_books(deduped, library_books)

            linked = sum(
                1 for e in entries if e["status"] == "linked"
            )
            unlinked_count = sum(
                1 for e in entries if e["status"] == "unlinked"
            )
            print(
                f"    {len(deduped)} positions:"
                f" {linked} linked, {unlinked_count} unlinked"
            )

            if commit:
                db.link_series(
                    USER_ID, sl_id, hc_id, hc_name,
                    data_hash=data_hash,
                )
                db.store_hc_series_books(sl_id, raw_books)
                db.upsert_series_entries(
                    sl_id, entries,
                    user_id=USER_ID, series_name=name,
                )

            matched_count += 1

        except Exception as exc:
            print(f"    ERROR: {exc}")

    print(f"\n  Matched {matched_count}/{len(unlinked)} series")


# --- Main ---


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Series cleanup: merge duplicates + refresh HC"
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually write changes (default: dry-run)",
    )
    parser.add_argument(
        "--phase",
        type=int,
        nargs="+",
        default=[1, 2, 3],
        help="Which phases to run (default: 1 2 3)",
    )
    args = parser.parse_args()

    if not DB_PATH.exists():
        print(f"Database not found: {DB_PATH}")
        return

    conn = get_conn()

    if 1 in args.phase:
        phase1_merge(conn, args.commit)
        if args.commit:
            conn.commit()

    conn.close()

    # Phase 2 & 3: HC API calls (use db module's connections)
    conn = get_conn()
    if 2 in args.phase:
        await phase2_rescan(conn, args.commit)
    if 3 in args.phase:
        await phase3_search(conn, args.commit)
    conn.close()

    if not args.commit:
        print("\nDRY RUN - no changes written.")
        print("Run with --commit to apply changes.")
    else:
        print("\nAll changes committed.")


if __name__ == "__main__":
    asyncio.run(main())
