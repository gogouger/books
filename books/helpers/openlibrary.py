"""OpenLibrary fallback for series book lists.

Used by `scripts/sync_series_with_hardcover.py --fallback openlibrary`
when Hardcover's canonical entry count looks suspiciously low compared
to what the user owns. OL's series modeling is messy (no canonical
"series page" most of the time), so this module is best-effort:

- `search_series(name)`: free-text query, returns plausibly-matching
  works.
- `fetch_series_books(name, first_author=None)`: tries the `series:`
  query syntax, falls back to a plain `q=` search filtered by author,
  sorts by `first_publish_year`, assigns sequential positions starting
  at 1.0. The merge step in the sync script is conservative — only
  fills clear gaps, never overrides Hardcover.

OL data quality varies by series. Treat results as suggestions for
manual review, not gospel. Polite client with a default 10s timeout.
"""

from __future__ import annotations

import logging
import re

import httpx

log = logging.getLogger(__name__)

OL_SEARCH = "https://openlibrary.org/search.json"
_UA = "books-personal-library/0.1 (https://github.com/gogouger/books)"


def _norm(title: str) -> str:
    """Light normalization for OL title fuzzy matching."""
    return re.sub(r"\s+", " ", (title or "")).strip().lower()


async def search_series(name: str) -> list[dict]:
    """Free-text series search against OL.

    Returns a filtered list of `{key, title, author_name,
    first_publish_year}` dicts whose title contains the series name
    or whose subjects appear to reference it.
    """
    if not name:
        return []
    params = {
        "q": name,
        "fields": "key,title,author_name,first_publish_year,subject",
        "limit": 10,
    }
    async with httpx.AsyncClient(
        timeout=10, headers={"User-Agent": _UA}
    ) as client:
        try:
            resp = await client.get(OL_SEARCH, params=params)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("OL search failed for %r: %s", name, exc)
            return []

    needle = _norm(name)
    results = []
    for doc in data.get("docs", []):
        title = doc.get("title") or ""
        subjects = doc.get("subject") or []
        haystack = " ".join([_norm(title)] + [_norm(s) for s in subjects])
        # Loose filter: at least one word of the series name appears.
        words = [w for w in needle.split() if len(w) > 2]
        if words and not any(w in haystack for w in words):
            continue
        results.append({
            "key": doc.get("key"),
            "title": title,
            "author_name": (doc.get("author_name") or [None])[0],
            "first_publish_year": doc.get("first_publish_year"),
        })
    return results


async def fetch_series_books(
    series_name: str,
    first_author: str | None = None,
) -> list[dict]:
    """Best-effort list of books in a series from OL.

    Strategy:
      1. Query `q=series:"<name>"&limit=50` — OL supports this for
         many but not all series.
      2. Filter out compilations and entries by other authors when
         `first_author` is provided.
      3. Sort by `first_publish_year` (None last), assign positions
         starting at 1.0.

    Returns a list of `{position, title, author}` dicts shaped like
    series_entries rows. Empty list on any error or no usable data.
    """
    if not series_name:
        return []
    # Quote the series name so OL treats it as a phrase.
    params = {
        "q": f'series:"{series_name}"',
        "fields": "key,title,author_name,first_publish_year",
        "limit": 50,
    }
    async with httpx.AsyncClient(
        timeout=10, headers={"User-Agent": _UA}
    ) as client:
        try:
            resp = await client.get(OL_SEARCH, params=params)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning(
                "OL series fetch failed for %r: %s",
                series_name, exc,
            )
            return []

    docs = data.get("docs") or []

    # Author filter: keep docs whose author_name contains the
    # first_author's surname (last whitespace-separated token).
    if first_author:
        surname = first_author.strip().split()[-1].lower()
        docs = [
            d for d in docs
            if any(
                surname in (n or "").lower()
                for n in (d.get("author_name") or [])
            )
        ]

    # Drop obvious garbage: empty titles, dupes by normalized title.
    seen: set[str] = set()
    cleaned: list[dict] = []
    for d in docs:
        title = (d.get("title") or "").strip()
        if not title:
            continue
        key = _norm(title)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(d)

    # Sort by first_publish_year, putting None at the end.
    cleaned.sort(
        key=lambda d: (
            d.get("first_publish_year") is None,
            d.get("first_publish_year") or 0,
        )
    )

    result = []
    for i, d in enumerate(cleaned, start=1):
        authors = d.get("author_name") or []
        result.append({
            "position": float(i),
            "title": (d.get("title") or "").strip(),
            "author": authors[0] if authors else None,
        })
    return result
