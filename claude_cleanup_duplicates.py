"""Clean up duplicate books and decimal-index books from the library database."""

import os
import sqlite3

DB_PATH = "/data/containers/books/data/books.db"
DATA_DIR = "/data/containers/books/data"


def merge_duplicates(conn: sqlite3.Connection) -> list[dict]:
    """Merge duplicate book pairs, keeping the entry with more data.

    Returns a list of actions taken.
    """
    actions = []
    cur = conn.cursor()

    # ---------------------------------------------------------------
    # Define all duplicate pairs: (keep_id, delete_id, merge_fields)
    # merge_fields is a dict of column->value to SET on the keeper
    # from the victim's data. Only non-null fields that the keeper lacks.
    # ---------------------------------------------------------------
    pairs = [
        # --- Series-crosslisted duplicates (bulk import 2026-02-18) ---
        # All have: keeper has epub + more metadata, victim is metadata-only
        (1098, 1130, {}),        # Aurora Rising (Prefect Dreyfus > Rev Space 0.1)
        (331, 1131, {}),         # Elysium Fire (Prefect Dreyfus > Rev Space 0.2)
        (511, 1135, {}),         # Revelation Space (already in Rev Space series)
        (139, 1261, {}),         # Coalescent (Destiny's Children > Xeelee #9)
        (138, 1262, {}),         # Exultant (Destiny's Children > Xeelee #10)
        (137, 1263, {}),         # Transcendent (Destiny's Children > Xeelee #11)
        (508, 1264, {}),         # Resplendent (Destiny's Children > Xeelee #12)
        (786, 1201, {}),         # The Alloy of Law (Wax & Wayne > Mistborn Saga)
        (787, 1203, {}),         # Shadows of Self (Wax & Wayne > Mistborn Saga)
        (788, 1204, {}),         # The Bands of Mourning (Wax & Wayne > Mistborn Saga)
        (789, 1205, {}),         # The Lost Metal (Wax & Wayne > Mistborn Saga)
        (485, 1171, {}),         # Privateers (Privateers > Grand Tour)
        (332, 1172, {}),         # Empire Builders (Privateers > Grand Tour)
        (447, 1173, {}),         # Moonrise (Moonbase Saga > Grand Tour)
        (448, 1174, {}),         # Moonwar (Moonbase Saga > Grand Tour)
        (338, 1136, {}),         # Fate of Worlds (Fleet of Worlds > Ringworld)
        (597, 1064, {}),         # The Faces of a Martyr (Dune > Legends of Dune)
        (741, 1029, {}),         # The Last Shadow (Shadow > Ender's Saga)
        (704, 1271, {}),         # Thousandth Night (House of Suns > Merlin)
        (480, 1150, {}),         # Prentice Alvin (same series, exact dup)

        # --- Bob Mayer / Robert Doherty pen name duplicates ---
        (115, 909, {}),          # The Grail (Area 51 #5, keeper has everything)
        (124, 911, {}),          # The Mission (Area 51 #3, keeper has everything)

        # --- True duplicates (same book entered twice) ---
        (650, 734, {}),          # Picture of Dorian Gray (identical, 650 was first)
        (53, 746, {}),           # Wayward Pines #1 (53 has rating 4.0, date_finished)
        (372, 1036, {}),         # Harry Potter (372 has read + rating 4.0)
        (409, 936, {}),          # Kingdom Come (409 has epub, both read/2.0)
        (346, 972, {}),          # Footfall (346 has epub, both read/5.0)
        (926, 1243, {}),         # Revolution (926 has read/4.0)

        # --- True duplicates with metadata to merge from victim ---
        # Worm: Keep 57 (has epub, rated 5.0). Merge series, author name,
        # goodreads_id, and date_finished from 919.
        (57, 919, {
            "authors": "Wildbow",
            "author_sort": "Wildbow",
            "series": "Parahumans",
            "goodreads_id": "18713259",
            "date_finished": "2020-01-24",
        }),
        # Beggar's Rebellion: Keep 922 (read, 5.0). Merge series info from 1129.
        (922, 1129, {
            "series": "Resonant Saga",
            "series_index": 1.0,
        }),
        # Free to Give: Keep 920 (rated 5.0). Merge date_finished from 929.
        (920, 929, {
            "date_finished": "2016-01-29",
        }),
        # The Goliath Stone: Keep 192 (has epub, rated 3.0). Merge date_finished.
        (192, 956, {
            "date_finished": "2015-03-04",
        }),
    ]

    for keep_id, delete_id, merge_fields in pairs:
        # Get titles for logging
        cur.execute("SELECT title FROM books WHERE id = ?", (keep_id,))
        row = cur.fetchone()
        if not row:
            actions.append(
                {"action": "SKIP", "keep": keep_id, "delete": delete_id,
                 "reason": f"Keeper ID {keep_id} not found"}
            )
            continue
        title = row[0]

        cur.execute("SELECT id FROM books WHERE id = ?", (delete_id,))
        if not cur.fetchone():
            actions.append(
                {"action": "SKIP", "keep": keep_id, "delete": delete_id,
                 "title": title, "reason": "Victim already deleted"}
            )
            continue

        # Apply metadata merges to keeper
        if merge_fields:
            set_clauses = ", ".join(f"{col} = ?" for col in merge_fields)
            values = list(merge_fields.values()) + [keep_id]
            cur.execute(
                f"UPDATE books SET {set_clauses} WHERE id = ?",  # noqa: S608
                values,
            )
            actions.append(
                {"action": "MERGE", "keep": keep_id, "delete": delete_id,
                 "title": title,
                 "merged": list(merge_fields.keys())}
            )

        # Delete victim from database
        cur.execute("DELETE FROM books WHERE id = ?", (delete_id,))

        # Delete victim's files (epub and cover)
        for subdir, ext in [("files", "epub"), ("covers", "jpg")]:
            path = os.path.join(DATA_DIR, subdir, "1", f"{delete_id}.{ext}")
            if os.path.exists(path):
                os.remove(path)
                actions.append(
                    {"action": "DELETE_FILE", "path": path}
                )

        actions.append(
            {"action": "DELETE_BOOK", "id": delete_id, "title": title,
             "kept": keep_id}
        )

    return actions


def delete_decimal_books(conn: sqlite3.Connection) -> list[dict]:
    """Delete books with non-integer series_index (novellas, split volumes).

    Returns a list of actions taken.
    """
    actions = []
    cur = conn.cursor()

    # Find all decimal-index books for user 1
    cur.execute("""
        SELECT id, title, series, series_index, authors, reading_status, rating
        FROM books
        WHERE user_id = 1
          AND series_index IS NOT NULL
          AND series_index != CAST(series_index AS INTEGER)
          AND series_index != 0.0
        ORDER BY series, series_index
    """)
    decimal_books = cur.fetchall()

    for book_id, title, series, idx, authors, status, rating in decimal_books:
        # Delete from database
        cur.execute("DELETE FROM books WHERE id = ?", (book_id,))

        # Delete associated files
        for subdir, ext in [("files", "epub"), ("covers", "jpg")]:
            path = os.path.join(DATA_DIR, subdir, "1", f"{book_id}.{ext}")
            if os.path.exists(path):
                os.remove(path)
                actions.append({"action": "DELETE_FILE", "path": path})

        actions.append({
            "action": "DELETE_DECIMAL",
            "id": book_id,
            "title": title,
            "series": series,
            "index": idx,
            "status": status,
            "rating": rating,
        })

    return actions


def main() -> None:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")

    # Get initial count
    initial_count = conn.execute(
        "SELECT COUNT(*) FROM books WHERE user_id = 1"
    ).fetchone()[0]
    print(f"Initial book count (user 1): {initial_count}")

    # Phase 1: Merge duplicates
    print("\n=== PHASE 1: Merging duplicates ===")
    dup_actions = merge_duplicates(conn)
    deletes = [a for a in dup_actions if a["action"] == "DELETE_BOOK"]
    merges = [a for a in dup_actions if a["action"] == "MERGE"]
    file_deletes = [a for a in dup_actions if a["action"] == "DELETE_FILE"]

    for m in merges:
        print(f"  MERGE #{m['keep']} <- fields {m['merged']} "
              f"| {m['title']}")
    for d in deletes:
        print(f"  DELETE #{d['id']} (kept #{d['kept']}) | {d['title']}")
    for f in file_deletes:
        print(f"  DELETE FILE {f['path']}")

    print(f"\n  Duplicates removed: {len(deletes)}")
    print(f"  Metadata merges: {len(merges)}")
    print(f"  Files deleted: {len(file_deletes)}")

    # Phase 2: Delete decimal-index books
    print("\n=== PHASE 2: Deleting decimal-index books ===")
    dec_actions = delete_decimal_books(conn)
    dec_deletes = [a for a in dec_actions if a["action"] == "DELETE_DECIMAL"]
    dec_files = [a for a in dec_actions if a["action"] == "DELETE_FILE"]

    for d in dec_deletes:
        print(f"  DELETE #{d['id']} | {d['series']} #{d['index']} "
              f"| {d['title']} [{d['status']}, {d['rating']}]")
    print(f"\n  Decimal books removed: {len(dec_deletes)}")
    print(f"  Files deleted: {len(dec_files)}")

    # Commit and report
    conn.commit()

    final_count = conn.execute(
        "SELECT COUNT(*) FROM books WHERE user_id = 1"
    ).fetchone()[0]
    print(f"\n=== SUMMARY ===")
    print(f"Books before: {initial_count}")
    print(f"Books after:  {final_count}")
    print(f"Total removed: {initial_count - final_count}")

    conn.close()


if __name__ == "__main__":
    main()
