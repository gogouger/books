"""Merge duplicate series_link rows created by the migration.

The _migrate_series_link_id() migration created orphan stub series_link
rows for books not matched to existing HC-linked series. This left some
series with two series_link entries (same series_name), splitting their
books across two links.

This script finds those duplicates, merges the orphan books into the
primary (HC-linked) series_link, and deletes the orphan link.

Usage:
    python claude_merge_series_links.py            # dry-run
    python claude_merge_series_links.py --commit   # write changes
"""

import argparse
import logging
import re
import sqlite3
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s: %(message)s",
)
log = logging.getLogger(__name__)

DB_PATH = Path("/data/containers/books/data/books.db")

STATUS_RANK = {"unread": 0, "reading": 1, "read": 2}


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


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


def _strip_diacritics(text: str) -> str:
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def normalize_title(title: str) -> str:
    """Normalize a title for comparison.

    Mirrors hardcover._normalize_title(): strips diacritics,
    subtitles, articles, punctuation, converts roman numerals.
    """
    title = _strip_diacritics(title)
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


# --- Duplicate finding ---


def find_duplicate_groups(
    conn: sqlite3.Connection,
) -> list[list[dict]]:
    """Find series_name groups with more than one series_link."""
    rows = conn.execute(
        """SELECT series_name, COUNT(*) as cnt
           FROM series_link
           GROUP BY series_name
           HAVING COUNT(*) > 1
           ORDER BY series_name"""
    ).fetchall()

    groups = []
    for row in rows:
        links = conn.execute(
            """SELECT sl.*,
                      (SELECT COUNT(*) FROM books b
                       WHERE b.series_link_id = sl.id) as book_count
               FROM series_link sl
               WHERE sl.series_name = ?
               ORDER BY sl.id""",
            (row["series_name"],),
        ).fetchall()
        groups.append([dict(l) for l in links])

    return groups


def pick_primary(links: list[dict]) -> tuple[dict, list[dict]]:
    """Pick the primary link and return (primary, orphans).

    Prefers: has hardcover_series_id, then most books, then lowest id.
    """
    def sort_key(link: dict) -> tuple:
        return (
            1 if link.get("hardcover_series_id") else 0,
            link.get("book_count", 0),
            -link["id"],  # negative so lowest id wins in tie
        )

    sorted_links = sorted(links, key=sort_key, reverse=True)
    primary = sorted_links[0]
    orphans = sorted_links[1:]
    return primary, orphans


# --- Book matching ---


def match_orphan_to_primary(
    orphan: dict,
    primary_books: list[dict],
    matched_ids: set[int],
) -> dict | None:
    """Try to match an orphan book to a primary book.

    3-tier matching:
    1. Exact series_index match
    2. Normalized title match
    3. Fuzzy title match (ratio > 0.80)

    Skips primary books already matched (in matched_ids).
    """
    candidates = [
        b for b in primary_books if b["id"] not in matched_ids
    ]
    if not candidates:
        return None

    orphan_index = orphan.get("series_index")
    orphan_norm = normalize_title(orphan["title"])

    # Tier 1: exact series_index match
    if orphan_index is not None:
        for pb in candidates:
            if pb.get("series_index") == orphan_index:
                return pb

    # Tier 2: normalized title match
    for pb in candidates:
        if normalize_title(pb["title"]) == orphan_norm:
            return pb

    # Tier 3: fuzzy title match
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


# --- Flag transfer ---


def compute_transfers(
    orphan: dict, primary: dict
) -> dict:
    """Compute upgrade-only transfers from orphan to primary.

    Only upgrades: is_owned 0->1, reading_status rank up,
    and fills null rating/date_finished/file_path/cover_filename.
    """
    updates = {}

    # is_owned: upgrade 0->1
    if orphan.get("is_owned") and not primary.get("is_owned"):
        updates["is_owned"] = 1

    # reading_status: rank up only
    orphan_rank = STATUS_RANK.get(
        orphan.get("reading_status", "unread"), 0
    )
    primary_rank = STATUS_RANK.get(
        primary.get("reading_status", "unread"), 0
    )
    if orphan_rank > primary_rank:
        updates["reading_status"] = orphan["reading_status"]

    # Fill-if-null fields
    for field in (
        "rating", "date_finished", "file_path", "cover_filename",
    ):
        if orphan.get(field) and not primary.get(field):
            updates[field] = orphan[field]

    return updates


# --- Main ---


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Merge duplicate series_link rows"
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually write changes (default: dry-run)",
    )
    args = parser.parse_args()

    if not DB_PATH.exists():
        log.error("Database not found: %s", DB_PATH)
        return

    conn = get_db()
    groups = find_duplicate_groups(conn)

    if not groups:
        print("No duplicate series_link entries found.")
        conn.close()
        return

    # Collect all operations
    transfers = []   # (primary_id, updates_dict, orphan_title)
    moves = []       # (book_id, new_link_id, title)
    deletes = []     # (book_id, title)
    link_deletes = []  # (link_id, series_name)

    print(f"\n{'=' * 60}")
    print("SERIES LINK MERGE REPORT")
    print(f"{'=' * 60}")
    print(f"Duplicate series groups: {len(groups)}\n")

    for group in groups:
        primary, orphan_links = pick_primary(group)
        series_name = primary["series_name"]

        primary_books = [
            dict(r) for r in conn.execute(
                "SELECT * FROM books WHERE series_link_id = ?",
                (primary["id"],),
            ).fetchall()
        ]

        print(f"--- {series_name} ---")
        hc_id = primary.get("hardcover_series_id") or "none"
        print(
            f"  Primary: link_id={primary['id']}"
            f" (HC={hc_id},"
            f" {primary['book_count']} books)"
        )

        for orphan_link in orphan_links:
            orphan_books = [
                dict(r) for r in conn.execute(
                    "SELECT * FROM books"
                    " WHERE series_link_id = ?",
                    (orphan_link["id"],),
                ).fetchall()
            ]
            ohc = orphan_link.get("hardcover_series_id") or "none"
            print(
                f"  Orphan:  link_id={orphan_link['id']}"
                f" (HC={ohc},"
                f" {orphan_link['book_count']} books)"
            )

            matched_primary_ids: set[int] = set()

            for ob in orphan_books:
                match = match_orphan_to_primary(
                    ob, primary_books, matched_primary_ids
                )

                if match:
                    matched_primary_ids.add(match["id"])
                    updates = compute_transfers(ob, match)

                    if updates:
                        transfers.append(
                            (match["id"], updates, ob["title"])
                        )
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
                            f" (no flags to transfer)"
                            f"  {ob['title'][:50]}"
                        )

                    deletes.append((ob["id"], ob["title"]))
                else:
                    moves.append(
                        (ob["id"], primary["id"], ob["title"])
                    )
                    print(
                        f"    MOVE: #{ob['id']}"
                        f" -> link {primary['id']}"
                        f"  {ob['title'][:50]}"
                    )

            link_deletes.append(
                (orphan_link["id"], series_name)
            )

        print()

    # Summary
    print(f"{'=' * 60}")
    print("SUMMARY")
    print(f"{'=' * 60}")
    print(f"  Flag transfers:      {len(transfers)}")
    print(f"  Book moves:          {len(moves)}")
    print(f"  Book deletes:        {len(deletes)}")
    print(f"  Series link deletes: {len(link_deletes)}")
    print()

    if not args.commit:
        print("DRY RUN - no changes written.")
        print("Run with --commit to apply changes.")
        conn.close()
        return

    # Execute in order (respects FK constraints):
    # 1. Transfer flags to primary books
    for primary_id, updates, _title in transfers:
        sets = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values())
        values.append(primary_id)
        conn.execute(
            f"UPDATE books SET {sets} WHERE id = ?",
            values,
        )

    # 2. Move unique books to primary link
    for book_id, new_link_id, _title in moves:
        conn.execute(
            "UPDATE books SET series_link_id = ?"
            " WHERE id = ?",
            (new_link_id, book_id),
        )

    # 3. Delete duplicate books
    for book_id, _title in deletes:
        conn.execute(
            "DELETE FROM books WHERE id = ?",
            (book_id,),
        )

    # 4. Delete orphan series_links (CASCADE cleans up
    #    series_entries and hc_series_books)
    for link_id, _name in link_deletes:
        conn.execute(
            "DELETE FROM series_link WHERE id = ?",
            (link_id,),
        )

    conn.commit()
    conn.close()

    print(
        f"DONE: transferred {len(transfers)} flags,"
        f" moved {len(moves)} books,"
        f" deleted {len(deletes)} duplicates,"
        f" removed {len(link_deletes)} orphan links."
    )


if __name__ == "__main__":
    main()
