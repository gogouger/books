#!/usr/bin/env python3
"""Add/move books to Ada's library from Andy's library.

Copies series structures (series_link, series_entries, hc_series_books)
and book records. Uses symlinks for epub/cover files to avoid duplication.
Moves Dragonlance and Spellsinger (reassigns user_id + moves files).
"""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path("/data/containers/books/data")
DB_PATH = DATA_DIR / "books.db"

ANDY = 1
ADA = 3


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def make_sort_title(title):
    lower = title.lower()
    for prefix in ("the ", "a ", "an "):
        if lower.startswith(prefix):
            return title[len(prefix) :] + ", " + title[: len(prefix) - 1]
    return title


def make_author_sort(authors):
    parts = []
    for author in authors.split(","):
        author = author.strip()
        names = author.split()
        if len(names) > 1:
            parts.append(f"{names[-1]}, {' '.join(names[:-1])}")
        else:
            parts.append(author)
    return " & ".join(parts)


def copy_series_link(conn, andy_link_id):
    """Copy a series_link from Andy to Ada, return new link ID."""
    link = dict(
        conn.execute(
            "SELECT * FROM series_link WHERE id = ?", (andy_link_id,)
        ).fetchone()
    )

    # Check if Ada already has this series
    existing = conn.execute(
        "SELECT id FROM series_link"
        " WHERE user_id = ? AND series_name = ?",
        (ADA, link["series_name"]),
    ).fetchone()
    if existing:
        return existing[0]

    cursor = conn.execute(
        """INSERT INTO series_link
           (user_id, series_name, hardcover_series_id,
            hardcover_series_name, hardcover_slug,
            last_checked, data_hash, monitored)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            ADA,
            link["series_name"],
            link["hardcover_series_id"],
            link["hardcover_series_name"],
            link["hardcover_slug"],
            link["last_checked"],
            link["data_hash"],
            link["monitored"],
        ),
    )
    return cursor.lastrowid


def copy_hc_series_books(conn, andy_link_id, ada_link_id):
    """Copy raw Hardcover series data from Andy's link to Ada's."""
    conn.execute(
        "DELETE FROM hc_series_books WHERE series_link_id = ?",
        (ada_link_id,),
    )
    entries = conn.execute(
        "SELECT * FROM hc_series_books WHERE series_link_id = ?",
        (andy_link_id,),
    ).fetchall()
    for e in entries:
        conn.execute(
            """INSERT INTO hc_series_books
               (series_link_id, position, title, author,
                hardcover_book_id, featured, compilation,
                ratings_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                ada_link_id,
                e["position"],
                e["title"],
                e["author"],
                e["hardcover_book_id"],
                e["featured"],
                e["compilation"],
                e["ratings_count"],
            ),
        )


def symlink_file(src, dst):
    """Create a symlink from dst -> src (absolute path)."""
    if src.exists() and not dst.exists():
        os.symlink(str(src.resolve()), str(dst))
        return True
    return False


def copy_book(conn, andy_book_id, ada_series_link_id=None):
    """Create a copy of a book record for Ada. Return new book ID."""
    row = conn.execute(
        "SELECT * FROM books WHERE id = ?", (andy_book_id,)
    ).fetchone()
    if not row:
        return None
    b = dict(row)
    now = datetime.now(timezone.utc).isoformat()

    cursor = conn.execute(
        """INSERT INTO books (
            user_id, title, sort_title, authors, author_sort,
            series, series_index, series_link_id,
            description, cover_filename, file_path,
            isbn, goodreads_id, tags, date_added,
            date_finished, published_date, rating,
            reading_status, progress, is_favorite, is_owned
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?
        )""",
        (
            ADA,
            b["title"],
            b["sort_title"],
            b["authors"],
            b["author_sort"],
            b["series"],
            b["series_index"],
            ada_series_link_id,
            b["description"],
            None,  # cover_filename - set below if exists
            None,  # file_path - set below if exists
            b["isbn"],
            b["goodreads_id"],
            b["tags"] if b["tags"] else "[]",
            now,
            None,  # date_finished - fresh for Ada
            b["published_date"],
            None,  # rating - fresh for Ada
            "unread",
            None,  # progress
            0,  # is_favorite
            b["is_owned"],
        ),
    )
    new_id = cursor.lastrowid

    # Symlink epub file if owned
    if b["is_owned"] and b["file_path"]:
        src = DATA_DIR / "files" / str(ANDY) / b["file_path"]
        dst_dir = DATA_DIR / "files" / str(ADA)
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / f"{new_id}.epub"
        if symlink_file(src, dst):
            conn.execute(
                "UPDATE books SET file_path = ? WHERE id = ?",
                (f"{new_id}.epub", new_id),
            )

    # Symlink cover file
    if b["cover_filename"]:
        src = DATA_DIR / "covers" / str(ANDY) / b["cover_filename"]
        dst_dir = DATA_DIR / "covers" / str(ADA)
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / f"{new_id}.jpg"
        if symlink_file(src, dst):
            conn.execute(
                "UPDATE books SET cover_filename = ?,"
                " cover_updated_at = ? WHERE id = ?",
                (f"{new_id}.jpg", b.get("cover_updated_at"), new_id),
            )

    return new_id


def copy_series_entries(conn, andy_link_id, ada_link_id, book_map):
    """Copy series entries from Andy to Ada with mapped book IDs."""
    entries = conn.execute(
        "SELECT * FROM series_entries WHERE series_link_id = ?",
        (andy_link_id,),
    ).fetchall()
    for e in entries:
        ada_book_id = book_map.get(e["book_id"]) if e["book_id"] else None
        conn.execute(
            """INSERT INTO series_entries
               (series_link_id, position, title, author,
                hardcover_book_id, status, book_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                ada_link_id,
                e["position"],
                e["title"],
                e["author"],
                e["hardcover_book_id"],
                e["status"],
                ada_book_id,
            ),
        )


def copy_series(conn, andy_link_id):
    """Copy a full series (link + books + entries + HC data) to Ada."""
    ada_link_id = copy_series_link(conn, andy_link_id)
    copy_hc_series_books(conn, andy_link_id, ada_link_id)

    # Copy all book records in this series
    books = conn.execute(
        "SELECT id FROM books"
        " WHERE user_id = ? AND series_link_id = ?",
        (ANDY, andy_link_id),
    ).fetchall()

    book_map = {}
    for b in books:
        new_id = copy_book(conn, b["id"], ada_link_id)
        if new_id:
            book_map[b["id"]] = new_id

    copy_series_entries(conn, andy_link_id, ada_link_id, book_map)
    return ada_link_id, book_map


def move_series(conn, andy_link_ids):
    """Move series from Andy to Ada (reassign user_id, move files)."""
    files_dst = DATA_DIR / "files" / str(ADA)
    covers_dst = DATA_DIR / "covers" / str(ADA)
    files_dst.mkdir(parents=True, exist_ok=True)
    covers_dst.mkdir(parents=True, exist_ok=True)

    for link_id in andy_link_ids:
        # Move series_link
        conn.execute(
            "UPDATE series_link SET user_id = ?"
            " WHERE id = ? AND user_id = ?",
            (ADA, link_id, ANDY),
        )

        # Move all books in this series
        books = conn.execute(
            "SELECT id, file_path, cover_filename FROM books"
            " WHERE user_id = ? AND series_link_id = ?",
            (ANDY, link_id),
        ).fetchall()

        for b in books:
            # Move epub
            if b["file_path"]:
                src = DATA_DIR / "files" / str(ANDY) / b["file_path"]
                if src.exists():
                    dst = files_dst / b["file_path"]
                    src.rename(dst)

            # Move cover
            if b["cover_filename"]:
                src = (
                    DATA_DIR / "covers" / str(ANDY) / b["cover_filename"]
                )
                if src.exists():
                    dst = covers_dst / b["cover_filename"]
                    src.rename(dst)

            # Update user_id
            conn.execute(
                "UPDATE books SET user_id = ?"
                " WHERE id = ? AND user_id = ?",
                (ADA, b["id"], ANDY),
            )


def main():
    conn = get_db()

    # Ensure directories exist
    (DATA_DIR / "files" / str(ADA)).mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "covers" / str(ADA)).mkdir(parents=True, exist_ok=True)

    print("=== COPYING series to Ada ===\n")

    # Dahl: Charlie Bucket series
    print("Charlie Bucket (Dahl)...")
    _, m = copy_series(conn, 22)
    print(f"  {len(m)} books")

    # Dahl: The Twits
    print("The Twits (Dahl)...")
    _, m = copy_series(conn, 142)
    print(f"  {len(m)} books")

    # Dahl: Revolting Rhymes (standalone)
    print("Revolting Rhymes (standalone)...")
    new_id = copy_book(conn, 215)
    print(f"  copied as book {new_id}")

    # Discworld
    print("Discworld...")
    _, m = copy_series(conn, 32)
    print(f"  {len(m)} books")

    # Harry Potter
    print("Harry Potter...")
    _, m = copy_series(conn, 45)
    print(f"  {len(m)} books")

    # Middle Earth (Tolkien)
    print("Middle Earth...")
    _, m = copy_series(conn, 61)
    print(f"  {len(m)} books")

    # His Dark Materials
    print("His Dark Materials...")
    _, m = copy_series(conn, 48)
    print(f"  {len(m)} books")

    # Hitchhiker's Guide to the Galaxy
    print("Hitchhiker's Guide...")
    _, m = copy_series(conn, 118)
    print(f"  {len(m)} books")

    print("\n=== MOVING series to Ada ===\n")

    # Dragonlance (both series_link entries)
    print("Dragonlance: Chronicles...")
    move_series(conn, [33, 160])
    print("  moved")

    # Spellsinger
    print("Spellsinger...")
    move_series(conn, [83])
    print("  moved")

    conn.commit()
    conn.close()

    # Verify
    conn = get_db()
    ada_books = conn.execute(
        "SELECT COUNT(*) FROM books WHERE user_id = ?", (ADA,)
    ).fetchone()[0]
    ada_owned = conn.execute(
        "SELECT COUNT(*) FROM books"
        " WHERE user_id = ? AND is_owned = 1",
        (ADA,),
    ).fetchone()[0]
    ada_series = conn.execute(
        "SELECT COUNT(*) FROM series_link WHERE user_id = ?", (ADA,)
    ).fetchone()[0]
    andy_books = conn.execute(
        "SELECT COUNT(*) FROM books WHERE user_id = ?", (ANDY,)
    ).fetchone()[0]
    conn.close()

    print(f"\n=== Results ===")
    print(f"Ada: {ada_books} books ({ada_owned} owned), {ada_series} series")
    print(f"Andy: {andy_books} books")


if __name__ == "__main__":
    main()
