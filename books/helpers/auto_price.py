"""Bulk auto-fill book prices from Google Books, falling back to
format/category defaults when no online price is available.

Strategy:
  1. Google Books `q=isbn:{isbn}` with country=US. If `saleInfo.listPrice`
     or `retailPrice` is set, use that (it's the publisher's list price
     in USD).
  2. Otherwise, apply a format + manual_category fallback. The defaults
     skew slightly toward Gordon's real shelf: theology hardcovers cost
     more than mass-market paperbacks.

Concurrency-controlled so a 600-book backfill takes ~30 seconds instead
of hammering Google. No API key needed — Google Books has an anonymous
quota of 1 000 req/day, well above one full library refresh.
"""

import asyncio
import logging
import re
from typing import Any

import httpx

from . import db

log = logging.getLogger(__name__)

GOOGLE_BOOKS_API = "https://www.googleapis.com/books/v1/volumes"
CONCURRENCY = 10

# Format + manual_category → USD median retail. Theology hardcovers
# (commentaries, study Bibles) are markedly pricier than fiction
# paperbacks, so Religious physical is the high outlier here.
DEFAULTS: dict[tuple[str, str], float] = {
    ("Religious", "physical"):  22.0,
    ("Religious", "ebook"):     11.0,
    ("Religious", "audiobook"): 18.0,
    ("Fiction", "physical"):    12.0,
    ("Fiction", "ebook"):       9.99,
    ("Fiction", "audiobook"):   14.95,
    ("Other", "physical"):      15.0,
    ("Other", "ebook"):         9.99,
    ("Other", "audiobook"):     14.95,
}


def _clean_isbn(raw: str | None) -> str:
    if not raw:
        return ""
    return re.sub(r"[^0-9X]", "", raw.upper())


async def _google_books_price(
    client: httpx.AsyncClient, isbn: str,
) -> float | None:
    """Probe Google Books for a USD list/retail price by ISBN."""
    if not isbn:
        return None
    clean = _clean_isbn(isbn)
    if len(clean) not in (10, 13):
        return None

    try:
        resp = await client.get(
            GOOGLE_BOOKS_API,
            params={"q": f"isbn:{clean}", "country": "US"},
            timeout=10.0,
        )
    except Exception:
        return None
    if resp.status_code != 200:
        return None

    try:
        data = resp.json()
    except Exception:
        return None

    for item in (data.get("items") or []):
        sale = item.get("saleInfo") or {}
        # listPrice = publisher's list; retailPrice = current Play store
        # price (often discounted). Prefer list — it's the cleaner "what
        # the book costs new" signal that survives across stores.
        for key in ("listPrice", "retailPrice"):
            entry = sale.get(key) or {}
            if entry.get("currencyCode") != "USD":
                continue
            amount = entry.get("amount")
            if isinstance(amount, (int, float)) and amount > 0:
                return round(float(amount), 2)
    return None


def _fallback_price(book: dict[str, Any]) -> float:
    cat = book.get("manual_category") or "Other"
    fmt = book.get("book_format") or "ebook"
    return DEFAULTS.get((cat, fmt), 15.0)


async def auto_price_user(user_id: int) -> dict:
    """Auto-fill prices for every unpriced book the user owns.

    Returns a summary dict:
      {filled, from_google, from_default, skipped, total_unpriced}
    """
    conn = db.get_db()
    rows = conn.execute(
        """
        SELECT id, title, isbn, book_format, manual_category
        FROM books
        WHERE user_id = ? AND price IS NULL
        """,
        (user_id,),
    ).fetchall()
    conn.close()
    books = [dict(r) for r in rows]

    summary = {
        "filled": 0,
        "from_google": 0,
        "from_default": 0,
        "skipped": 0,
        "total_unpriced": len(books),
    }
    if not books:
        return summary

    sem = asyncio.Semaphore(CONCURRENCY)
    # In-memory list of (book_id, price, source) to write after all
    # network calls land — keeps the SQLite writes serial.
    results: list[tuple[int, float, str]] = []

    async def process(client: httpx.AsyncClient, book: dict) -> None:
        async with sem:
            price = await _google_books_price(client, book.get("isbn") or "")
            if price is not None:
                results.append((book["id"], price, "google"))
            else:
                results.append((
                    book["id"], _fallback_price(book), "default",
                ))

    async with httpx.AsyncClient(
        follow_redirects=True,
        headers={"User-Agent": "athenaeum/1.0 gordon@ggouger.com"},
    ) as client:
        await asyncio.gather(*(process(client, b) for b in books))

    for book_id, price, source in results:
        try:
            db.update_book(book_id, user_id, {"price": price})
            summary["filled"] += 1
            summary[f"from_{source}"] += 1
        except Exception:
            log.exception("update failed for book %d", book_id)
            summary["skipped"] += 1

    return summary
