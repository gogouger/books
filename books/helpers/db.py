import json
import logging
import sqlite3
from pathlib import Path

from decouple import config

log = logging.getLogger(__name__)

DATA_DIR = Path(config("BOOKS_DATA_DIR", default="/app/data"))
DB_PATH = DATA_DIR / "books.db"

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

CREATE INDEX IF NOT EXISTS idx_books_user
    ON books(user_id);
CREATE INDEX IF NOT EXISTS idx_books_series
    ON books(user_id, series);
CREATE INDEX IF NOT EXISTS idx_books_read
    ON books(user_id, is_read);
"""


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "covers").mkdir(exist_ok=True)
    (DATA_DIR / "files").mkdir(exist_ok=True)
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
    log.info("Database initialized at %s", DB_PATH)


# --- User queries ---


def get_user_by_username(username: str) -> dict | None:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return dict(row)


def get_user_by_id(user_id: int) -> dict | None:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return dict(row)


def create_user(
    username: str,
    display_name: str,
    password_hash: str,
    kindle_email: str | None = None,
) -> int:
    conn = get_db()
    cursor = conn.execute(
        """INSERT INTO users (username, display_name, password_hash,
           kindle_email)
           VALUES (?, ?, ?, ?)""",
        (username, display_name, password_hash, kindle_email),
    )
    conn.commit()
    user_id = cursor.lastrowid
    conn.close()
    return user_id


def update_user_kindle_email(
    user_id: int, kindle_email: str
) -> None:
    conn = get_db()
    conn.execute(
        "UPDATE users SET kindle_email = ? WHERE id = ?",
        (kindle_email, user_id),
    )
    conn.commit()
    conn.close()


# --- Book queries ---


def _row_to_book(row: sqlite3.Row) -> dict:
    book = dict(row)
    if book.get("tags"):
        try:
            book["tags"] = json.loads(book["tags"])
        except (json.JSONDecodeError, TypeError):
            book["tags"] = []
    else:
        book["tags"] = []
    return book


def get_books(
    user_id: int,
    q: str | None = None,
    series: str | None = None,
    is_read: int | None = None,
    min_rating: float | None = None,
    max_rating: float | None = None,
    sort: str = "title",
    order: str = "asc",
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    conditions = ["user_id = ?"]
    params: list = [user_id]

    if q:
        conditions.append(
            "(title LIKE ? OR authors LIKE ?)"
        )
        like = f"%{q}%"
        params.extend([like, like])

    if series is not None:
        conditions.append("series = ?")
        params.append(series)

    if is_read is not None:
        conditions.append("is_read = ?")
        params.append(is_read)

    if min_rating is not None:
        conditions.append("rating >= ?")
        params.append(min_rating)

    if max_rating is not None:
        conditions.append("rating <= ?")
        params.append(max_rating)

    allowed_sort = {
        "title": "sort_title",
        "author": "author_sort",
        "date_added": "date_added",
        "date_finished": "date_finished",
        "rating": "rating",
        "series": "series, series_index",
    }
    sort_col = allowed_sort.get(sort, "sort_title")
    order_dir = "DESC" if order.lower() == "desc" else "ASC"

    where = " AND ".join(conditions)
    query = f"""
        SELECT * FROM books
        WHERE {where}
        ORDER BY {sort_col} {order_dir}
        LIMIT ? OFFSET ?
    """
    params.extend([limit, offset])

    conn = get_db()
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [_row_to_book(r) for r in rows]


def count_books(
    user_id: int,
    q: str | None = None,
    series: str | None = None,
    is_read: int | None = None,
    min_rating: float | None = None,
    max_rating: float | None = None,
) -> int:
    conditions = ["user_id = ?"]
    params: list = [user_id]

    if q:
        conditions.append(
            "(title LIKE ? OR authors LIKE ?)"
        )
        like = f"%{q}%"
        params.extend([like, like])

    if series is not None:
        conditions.append("series = ?")
        params.append(series)

    if is_read is not None:
        conditions.append("is_read = ?")
        params.append(is_read)

    if min_rating is not None:
        conditions.append("rating >= ?")
        params.append(min_rating)

    if max_rating is not None:
        conditions.append("rating <= ?")
        params.append(max_rating)

    where = " AND ".join(conditions)
    query = f"SELECT COUNT(*) FROM books WHERE {where}"

    conn = get_db()
    count = conn.execute(query, params).fetchone()[0]
    conn.close()
    return count


def get_book(book_id: int, user_id: int) -> dict | None:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM books WHERE id = ? AND user_id = ?",
        (book_id, user_id),
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return _row_to_book(row)


def insert_book(
    user_id: int,
    title: str,
    sort_title: str,
    authors: str,
    author_sort: str | None,
    series: str | None,
    series_index: float | None,
    description: str | None,
    cover_filename: str | None,
    file_path: str | None,
    isbn: str | None,
    goodreads_id: str | None,
    tags: list[str] | None,
    date_added: str,
    date_finished: str | None,
    rating: float | None,
    is_read: int,
) -> int:
    tags_json = json.dumps(tags) if tags else "[]"
    conn = get_db()
    cursor = conn.execute(
        """INSERT INTO books (
            user_id, title, sort_title, authors, author_sort,
            series, series_index, description, cover_filename,
            file_path, isbn, goodreads_id, tags, date_added,
            date_finished, rating, is_read
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?)""",
        (
            user_id, title, sort_title, authors, author_sort,
            series, series_index, description, cover_filename,
            file_path, isbn, goodreads_id, tags_json,
            date_added, date_finished, rating, is_read,
        ),
    )
    conn.commit()
    book_id = cursor.lastrowid
    conn.close()
    return book_id


def update_book(
    book_id: int, user_id: int, updates: dict
) -> bool:
    if not updates:
        return False

    if "tags" in updates and isinstance(updates["tags"], list):
        updates["tags"] = json.dumps(updates["tags"])

    allowed = {
        "title", "sort_title", "authors", "author_sort",
        "series", "series_index", "description",
        "cover_filename", "file_path", "isbn", "goodreads_id",
        "tags", "date_finished", "rating", "is_read",
    }
    filtered = {
        k: v for k, v in updates.items() if k in allowed
    }
    if not filtered:
        return False

    sets = ", ".join(f"{k} = ?" for k in filtered)
    values = list(filtered.values())
    values.extend([book_id, user_id])

    conn = get_db()
    cursor = conn.execute(
        f"UPDATE books SET {sets} WHERE id = ? AND user_id = ?",
        values,
    )
    conn.commit()
    changed = cursor.rowcount > 0
    conn.close()
    return changed


def delete_book(book_id: int, user_id: int) -> bool:
    conn = get_db()
    cursor = conn.execute(
        "DELETE FROM books WHERE id = ? AND user_id = ?",
        (book_id, user_id),
    )
    conn.commit()
    deleted = cursor.rowcount > 0
    conn.close()
    return deleted


# --- Series queries ---


def get_series_list(user_id: int) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT series,
                  COUNT(*) as total_books,
                  SUM(is_read) as read_count,
                  COUNT(*) - SUM(is_read) as unread_count,
                  MIN(rating) as min_rating,
                  MAX(rating) as max_rating,
                  AVG(rating) as avg_rating
           FROM books
           WHERE user_id = ? AND series IS NOT NULL
           GROUP BY series
           ORDER BY series""",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_series_books(
    user_id: int, series_name: str
) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT * FROM books
           WHERE user_id = ? AND series = ?
           ORDER BY series_index""",
        (user_id, series_name),
    ).fetchall()
    conn.close()
    return [_row_to_book(r) for r in rows]
