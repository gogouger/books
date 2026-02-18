#!/usr/bin/env python3
"""One-time import from Calibre libraries into the books app database.

Usage:
    python import_calibre.py [--db /path/to/books.db]

Imports all three libraries (andy, liz, ada) from the standard
Calibre paths under /data/media/books/calibre/.
"""

import argparse
import hashlib
import json
import logging
import shutil
import sqlite3
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

CALIBRE_BASE = Path("/data/media/books/calibre")
DEFAULT_DB = Path("/data/containers/books/data/books.db")
COVERS_DIR = Path("/data/containers/books/data/covers")
FILES_DIR = Path("/data/containers/books/data/files")

LIBRARIES = [
    {"username": "andy", "display_name": "Andy", "password": "andy"},
    {"username": "liz", "display_name": "Liz", "password": "liz"},
    {"username": "ada", "display_name": "Ada", "password": "ada"},
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    kindle_email TEXT
);

CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    authors TEXT NOT NULL,
    author_sort TEXT,
    series TEXT,
    series_index REAL,
    description TEXT,
    cover_filename TEXT,
    file_path TEXT,
    isbn TEXT,
    goodreads_id TEXT,
    tags TEXT,
    date_added TEXT NOT NULL,
    date_finished TEXT,
    rating REAL,
    is_read INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
CREATE INDEX IF NOT EXISTS idx_books_series ON books(user_id, series);
CREATE INDEX IF NOT EXISTS idx_books_read ON books(user_id, is_read);
"""


def hash_password(password: str) -> str:
    return hashlib.sha256(
        (password + "books_salt").encode("utf-8")
    ).hexdigest()


def ensure_user(conn: sqlite3.Connection, lib: dict) -> int:
    row = conn.execute(
        "SELECT id FROM users WHERE username = ?",
        (lib["username"],),
    ).fetchone()
    if row:
        return row[0]
    cursor = conn.execute(
        """INSERT INTO users (username, display_name, password_hash)
           VALUES (?, ?, ?)""",
        (
            lib["username"],
            lib["display_name"],
            hash_password(lib["password"]),
        ),
    )
    conn.commit()
    log.info("Created user: %s (id=%d)", lib["username"], cursor.lastrowid)
    return cursor.lastrowid


def _open_calibre_db(calibre_db: Path) -> sqlite3.Connection:
    """Open Calibre DB, recovering via dump/restore if corrupted."""
    import subprocess
    import tempfile

    # Always recover via dump/restore since Calibre DBs are often
    # in a partially corrupted state from VNC container restarts.
    log.info("Recovering Calibre DB: %s", calibre_db)

    # Recover via dump/restore
    recovered = Path(tempfile.mktemp(suffix=".db"))
    dump_proc = subprocess.run(
        ["sqlite3", str(calibre_db), ".dump"],
        capture_output=True, text=True,
    )
    restore_proc = subprocess.run(
        ["sqlite3", str(recovered)],
        input=dump_proc.stdout, capture_output=True, text=True,
    )
    if restore_proc.returncode != 0:
        # Some constraint violations are expected, check we got data
        pass

    conn = sqlite3.connect(str(recovered))
    count = conn.execute("SELECT COUNT(*) FROM books").fetchone()[0]
    log.info("Recovered %d books from corrupted DB", count)
    conn.row_factory = sqlite3.Row
    return conn


def read_calibre_books(calibre_db: Path) -> list[dict]:
    """Read all books from a Calibre metadata.db with full joins."""
    cal = _open_calibre_db(calibre_db)

    # Check which custom columns exist
    custom_cols = {}
    try:
        for row in cal.execute("SELECT * FROM custom_columns"):
            custom_cols[row["id"]] = row["label"]
    except Exception:
        pass

    has_read = 1 in custom_cols  # custom_column_1 = read (bool)
    has_stars = 2 in custom_cols  # custom_column_2 = stars (rating)

    query = """
        SELECT
            b.id,
            b.title,
            b.sort as sort_title,
            b.author_sort,
            b.series_index,
            b.isbn,
            b.path,
            b.has_cover,
            b.timestamp as date_added,
            GROUP_CONCAT(DISTINCT a.name) as authors,
            s.name as series,
            c.text as description,
            r.rating as calibre_rating
        FROM books b
        LEFT JOIN books_authors_link bal ON b.id = bal.book
        LEFT JOIN authors a ON bal.author = a.id
        LEFT JOIN books_series_link bsl ON b.id = bsl.book
        LEFT JOIN series s ON bsl.series = s.id
        LEFT JOIN comments c ON b.id = c.book
        LEFT JOIN books_ratings_link brl ON b.id = brl.book
        LEFT JOIN ratings r ON brl.rating = r.id
        GROUP BY b.id
    """
    rows = cal.execute(query).fetchall()

    books = []
    for row in rows:
        book = dict(row)

        # Get tags
        tags_rows = cal.execute(
            """SELECT t.name FROM books_tags_link btl
               JOIN tags t ON btl.tag = t.id
               WHERE btl.book = ?""",
            (book["id"],),
        ).fetchall()
        book["tags"] = [t["name"] for t in tags_rows]

        # Get identifiers (goodreads, isbn, etc)
        ident_rows = cal.execute(
            "SELECT type, val FROM identifiers WHERE book = ?",
            (book["id"],),
        ).fetchall()
        identifiers = {i["type"]: i["val"] for i in ident_rows}
        book["goodreads_id"] = identifiers.get("goodreads", "")
        if not book["isbn"] and "isbn" in identifiers:
            book["isbn"] = identifiers["isbn"]

        # Get epub filename from data table
        data_row = cal.execute(
            "SELECT name, format FROM data WHERE book = ? AND format = 'EPUB'",
            (book["id"],),
        ).fetchone()
        book["epub_filename"] = (
            f"{data_row['name']}.epub" if data_row else None
        )

        # Get custom column values
        if has_read:
            read_row = cal.execute(
                "SELECT value FROM custom_column_1 WHERE book = ?",
                (book["id"],),
            ).fetchone()
            book["is_read"] = (
                1 if read_row and read_row["value"] else 0
            )
        else:
            book["is_read"] = 0

        if has_stars:
            stars_row = cal.execute(
                """SELECT cc2.value FROM books_custom_column_2_link bcc2
                   JOIN custom_column_2 cc2 ON bcc2.value = cc2.id
                   WHERE bcc2.book = ?""",
                (book["id"],),
            ).fetchone()
            # custom_column_2 stores rating as 0-10, convert to 0-5
            book["stars"] = (
                stars_row["value"] / 2.0 if stars_row else None
            )
        else:
            # Fall back to Calibre's built-in rating (also 0-10)
            book["stars"] = (
                book["calibre_rating"] / 2.0
                if book["calibre_rating"]
                else None
            )

        books.append(book)

    cal.close()
    return books


def import_library(
    conn: sqlite3.Connection,
    user_id: int,
    username: str,
) -> dict:
    """Import a single Calibre library."""
    calibre_path = CALIBRE_BASE / username
    calibre_db = calibre_path / "metadata.db"

    if not calibre_db.exists():
        log.warning("Calibre DB not found: %s", calibre_db)
        return {"imported": 0, "skipped": 0, "errors": 0}

    user_covers = COVERS_DIR / str(user_id)
    user_files = FILES_DIR / str(user_id)
    user_covers.mkdir(parents=True, exist_ok=True)
    user_files.mkdir(parents=True, exist_ok=True)

    calibre_books = read_calibre_books(calibre_db)
    imported = 0
    skipped = 0
    errors = 0

    for cb in calibre_books:
        try:
            if not cb.get("epub_filename"):
                log.warning(
                    "No EPUB for '%s', skipping", cb["title"]
                )
                skipped += 1
                continue

            tags_json = json.dumps(cb["tags"])
            cursor = conn.execute(
                """INSERT INTO books (
                    user_id, title, sort_title, authors,
                    author_sort, series, series_index,
                    description, cover_filename, file_path,
                    isbn, goodreads_id, tags, date_added,
                    date_finished, rating, is_read
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?
                )""",
                (
                    user_id,
                    cb["title"],
                    cb["sort_title"] or cb["title"],
                    cb["authors"] or "Unknown",
                    cb["author_sort"],
                    cb["series"],
                    cb["series_index"],
                    cb["description"],
                    None,  # cover_filename - set after copy
                    None,  # file_path - set after copy
                    cb["isbn"],
                    cb["goodreads_id"],
                    tags_json,
                    cb["date_added"] or "2024-01-01T00:00:00",
                    None,  # date_finished
                    cb["stars"],
                    cb["is_read"],
                ),
            )
            new_id = cursor.lastrowid

            # Copy cover
            cover_src = calibre_path / cb["path"] / "cover.jpg"
            if cb["has_cover"] and cover_src.exists():
                cover_dst = user_covers / f"{new_id}.jpg"
                shutil.copy2(str(cover_src), str(cover_dst))
                conn.execute(
                    "UPDATE books SET cover_filename = ? WHERE id = ?",
                    (f"{new_id}.jpg", new_id),
                )

            # Copy epub
            epub_src = (
                calibre_path / cb["path"] / cb["epub_filename"]
            )
            if epub_src.exists():
                epub_dst = user_files / f"{new_id}.epub"
                shutil.copy2(str(epub_src), str(epub_dst))
                conn.execute(
                    "UPDATE books SET file_path = ? WHERE id = ?",
                    (f"{new_id}.epub", new_id),
                )
            else:
                log.warning(
                    "EPUB not found: %s", epub_src
                )

            imported += 1
        except Exception:
            log.exception(
                "Error importing '%s'", cb.get("title", "?")
            )
            errors += 1

    conn.commit()
    return {
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import Calibre libraries"
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        help="Path to books.db",
    )
    args = parser.parse_args()

    db_path = args.db
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    conn.commit()

    for lib in LIBRARIES:
        user_id = ensure_user(conn, lib)
        log.info(
            "Importing library for %s (user_id=%d)...",
            lib["username"],
            user_id,
        )
        result = import_library(conn, user_id, lib["username"])
        log.info(
            "  %s: imported=%d, skipped=%d, errors=%d",
            lib["username"],
            result["imported"],
            result["skipped"],
            result["errors"],
        )

    # Final summary
    total = conn.execute("SELECT COUNT(*) FROM books").fetchone()[0]
    users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    log.info(
        "Import complete: %d books, %d users", total, users
    )
    conn.close()


if __name__ == "__main__":
    main()
