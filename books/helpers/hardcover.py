import hashlib
import json
import logging
import re
import unicodedata
from difflib import SequenceMatcher

import httpx
from decouple import config

log = logging.getLogger(__name__)

HARDCOVER_API_URL = "https://api.hardcover.app/v1/graphql"
HARDCOVER_API_TOKEN = config("HARDCOVER_API_TOKEN", default="")


async def _graphql(query: str, variables: dict | None = None) -> dict:
    """Execute a GraphQL query against the Hardcover API."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": HARDCOVER_API_TOKEN,
    }
    payload: dict = {"query": query}
    if variables:
        payload["variables"] = variables
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            HARDCOVER_API_URL,
            json=payload,
            headers=headers,
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("errors"):
            log.warning(
                "Hardcover GraphQL errors: %s",
                result["errors"],
            )
        return result


# --- Book search ---


async def search_books(
    query: str, per_page: int = 5
) -> list[dict]:
    """Search Hardcover for books by query string.

    Returns list of {id, title, author}.
    """
    gql = """
    {
      search(
        query: "%s",
        query_type: "books",
        per_page: %d
      ) {
        results
      }
    }
    """ % (query.replace('"', '\\"'), per_page)

    try:
        data = await _graphql(gql)
    except Exception:
        log.exception(
            "Hardcover book search failed for %s", query
        )
        return []

    results = []
    hits = (
        data.get("data", {})
        .get("search", {})
        .get("results", {})
        .get("hits", [])
    )
    log.info(
        "Hardcover search for %r returned %d hits",
        query, len(hits),
    )
    for hit in hits:
        doc = hit.get("document", {})
        results.append({
            "id": int(doc["id"]),
            "title": doc.get("title", ""),
            "author": doc.get("author", ""),
        })
    return results


async def fetch_book_detail(book_id: int) -> dict | None:
    """Fetch detailed metadata for a single Hardcover book.

    Returns normalized dict with title, authors, description,
    isbn, published_date, cover_url, or None on failure.
    """
    gql = """
    {
      books_by_pk(id: %d) {
        title
        description
        release_date
        image {
          url
        }
        contributions {
          author {
            name
          }
        }
        default_physical_edition {
          isbn_13
          isbn_10
        }
        default_ebook_edition {
          isbn_13
          isbn_10
        }
        book_series {
          position
          series {
            id
            name
            slug
          }
        }
      }
    }
    """ % book_id

    try:
        data = await _graphql(gql)
    except Exception:
        log.exception(
            "Hardcover fetch_book_detail failed for %d",
            book_id,
        )
        return None

    book = data.get("data", {}).get("books_by_pk")
    if not book:
        log.warning(
            "Hardcover fetch_book_detail(%d): "
            "no book in response, raw data=%s",
            book_id, data.get("data"),
        )
        return None
    log.info(
        "Hardcover fetch_book_detail(%d): found %r",
        book_id, book.get("title", ""),
    )
    authors = [
        c["author"]["name"]
        for c in book.get("contributions", [])
        if c.get("author", {}).get("name")
    ]
    # ISBN lives on editions, not books
    isbn = ""
    for edition_key in (
        "default_physical_edition",
        "default_ebook_edition",
    ):
        ed = book.get(edition_key) or {}
        isbn = ed.get("isbn_13") or ed.get("isbn_10") or ""
        if isbn:
            break
    image = book.get("image") or {}

    # Series from first book_series entry
    series_name = ""
    series_index = None
    series_hardcover_id = None
    series_slug = ""
    book_series = book.get("book_series") or []
    if book_series:
        bs = book_series[0]
        series_info = bs.get("series") or {}
        series_name = series_info.get("name") or ""
        series_index = bs.get("position")
        series_hardcover_id = series_info.get("id")
        series_slug = series_info.get("slug") or ""

    return {
        "title": book.get("title", ""),
        "authors": ", ".join(authors),
        "description": book.get("description") or "",
        "isbn": isbn,
        "published_date": book.get("release_date") or "",
        "cover_url": image.get("url") or "",
        "series_name": series_name,
        "series_index": series_index,
        "series_hardcover_id": series_hardcover_id,
        "series_slug": series_slug,
    }


def pick_best_book(
    query_title: str,
    query_author: str,
    results: list[dict],
) -> dict | None:
    """Pick best book match from search results.

    Scores by combined title + author similarity using
    existing normalize/fuzzy helpers.
    """
    if not results:
        log.info("pick_best_book: no results to pick from")
        return None
    if len(results) == 1:
        log.info(
            "pick_best_book: single result %r",
            results[0].get("title", ""),
        )
        return results[0]

    best = None
    best_score = -1.0
    title_norm = normalize_title(query_title)
    author_norm = query_author.strip().lower()
    for r in results:
        t_score = _fuzzy_ratio(
            title_norm, normalize_title(r.get("title", ""))
        )
        a_score = _fuzzy_ratio(
            author_norm, r.get("author", "").strip().lower()
        )
        score = t_score * 0.6 + a_score * 0.4
        log.debug(
            "pick_best_book candidate: %r by %r "
            "t=%.3f a=%.3f total=%.3f",
            r.get("title", ""), r.get("author", ""),
            t_score, a_score, score,
        )
        if score > best_score:
            best_score = score
            best = r
    log.info(
        "pick_best_book: best score=%.3f title=%r",
        best_score, best.get("title", "") if best else "",
    )
    return best


# --- Series search ---


async def search_series(name: str) -> list[dict]:
    """Search Hardcover for series by name.

    Returns list of {id, name, slug, books_count}, filtered to
    series that have at least one book.
    """
    query = """
    {
      search(
        query: "%s",
        query_type: "series",
        per_page: 5
      ) {
        results
      }
    }
    """ % name.replace('"', '\\"')

    try:
        data = await _graphql(query)
    except Exception:
        log.exception("Hardcover series search failed for %s", name)
        return []

    results = []
    hits = (
        data.get("data", {})
        .get("search", {})
        .get("results", {})
        .get("hits", [])
    )
    for hit in hits:
        doc = hit.get("document", {})
        count = doc.get("primary_books_count") or 0
        if count <= 0:
            continue
        results.append({
            "id": int(doc["id"]),
            "name": doc.get("name", ""),
            "slug": doc.get("slug", ""),
            "books_count": count,
        })
    return results


def pick_best_series(
    query: str, results: list[dict]
) -> dict | None:
    """Pick the best series match from search results.

    Scores each result by normalized title similarity to the
    query. Returns the best match, or None if results is empty.
    """
    if not results:
        return None
    if len(results) == 1:
        return results[0]

    best = None
    best_score = -1.0
    query_norm = normalize_title(query)
    for r in results:
        score = _fuzzy_ratio(query_norm, normalize_title(r["name"]))
        if score > best_score:
            best_score = score
            best = r
    return best


async def fetch_series_slugs(
    series_ids: list[int],
) -> dict[int, str]:
    """Fetch slugs for series by their Hardcover IDs.

    Args:
        series_ids: List of Hardcover series IDs.

    Returns:
        Dict mapping series_id to slug string.
    """
    if not series_ids:
        return {}

    results: dict[int, str] = {}
    # Batch in groups of 50 to avoid oversized queries
    for i in range(0, len(series_ids), 50):
        batch = series_ids[i:i + 50]
        id_list = ", ".join(str(sid) for sid in batch)
        query = """
        {
          series(where: {id: {_in: [%s]}}) {
            id
            slug
          }
        }
        """ % id_list
        try:
            data = await _graphql(query)
        except Exception:
            log.exception(
                "Hardcover fetch_series_slugs failed for batch"
            )
            continue
        for s in data.get("data", {}).get("series", []):
            results[s["id"]] = s["slug"]
    return results


# --- Series books: fetch, store, dedup ---


async def fetch_series_books(series_id: int) -> list[dict]:
    """Fetch all book entries for a series from Hardcover.

    Returns the raw list of all entries (including translations,
    compilations, etc.) without deduplication. Each entry has:
    {position, title, author, hardcover_book_id, featured,
     compilation, ratings_count}.
    """
    query = """
    {
      series_by_pk(id: %d) {
        id
        name
        book_series(
          order_by: {position: asc_nulls_last}
        ) {
          position
          compilation
          featured
          book {
            id
            title
            contributions {
              author { name }
            }
            ratings_count
          }
        }
      }
    }
    """ % series_id

    try:
        data = await _graphql(query)
    except Exception:
        log.exception(
            "Hardcover fetch_series_books failed for %d", series_id
        )
        return []

    series = data.get("data", {}).get("series_by_pk")
    if not series:
        return []

    entries = []
    for bs in series.get("book_series", []):
        book = bs.get("book", {})
        authors = [
            c["author"]["name"]
            for c in book.get("contributions", [])
            if c.get("author", {}).get("name")
        ]
        entries.append({
            "position": bs.get("position"),
            "title": book.get("title", ""),
            "author": authors[0] if authors else "",
            "hardcover_book_id": book.get("id"),
            "featured": bool(bs.get("featured")),
            "compilation": bool(bs.get("compilation")),
            "ratings_count": book.get("ratings_count", 0),
        })

    return entries


def compute_data_hash(raw_entries: list[dict]) -> str:
    """Compute a hash of raw HC entries for change detection.

    Hashes the sorted set of (hardcover_book_id, position)
    tuples so we can skip re-matching when data hasn't changed.
    """
    key_data = sorted(
        (e.get("hardcover_book_id"), e.get("position"))
        for e in raw_entries
    )
    return hashlib.md5(
        json.dumps(key_data).encode()
    ).hexdigest()


# Distinctive non-English words / particles that catch all-ASCII titles
# in Romance languages. The 0.8 ASCII-ratio check used to let entries
# like "Os Arquivos do Semideus" (Portuguese, 100% ASCII) slip through.
_NON_ENGLISH_TOKENS = frozenset({
    # Portuguese
    "os", "do", "da", "dos", "das", "semideus", "arquivos",
    # Spanish
    "el", "los", "las", "una", "uno",
    # French
    "des", "du", "le", "les", "communauté", "sœurs",
    # German
    "der", "die", "das", "und", "von", "ein", "eine",
    # Italian
    "lo", "gli", "il", "della", "delle", "dei",
    # Polish (mostly ASCII)
    "diuny", "łowcy", "czerwie",
    # Catalan
    "fills", "boira", "pou", "ascensió", "heroi", "eternitat",
    # Turkish
    "kahramanları", "melez", "günlükleri", "olimpos",
})


def _is_likely_english(title: str) -> bool:
    """Check if a title is likely English/Latin-script.

    Two-step check: (1) reject any title containing non-Latin letter
    characters outside basic ASCII (catches Turkish ı, French ç,
    Polish Ł, etc., but allows common punctuation like em-dashes and
    smart quotes); (2) for all-ASCII titles, check for distinctive
    non-English particles in the token list — catches things like
    "Os Arquivos do Semideus" that the old 0.8 ASCII-ratio threshold
    missed.
    """
    if not title:
        return False
    # Allow basic ASCII plus common typographic punctuation.
    _PUNCT_OK = {
        0x2013, 0x2014,  # en/em dash
        0x2018, 0x2019,  # smart single quotes
        0x201C, 0x201D,  # smart double quotes
        0x2026,          # ellipsis
        0x00A0,          # non-breaking space
    }
    for c in title:
        cp = ord(c)
        if cp > 127 and cp not in _PUNCT_OK:
            return False
    # All-ASCII title: check for non-English stopwords as a tiebreaker.
    words = re.findall(r"[a-zA-Z]+", title.lower())
    non_en_hits = sum(1 for w in words if w in _NON_ENGLISH_TOKENS)
    # Two distinctive non-English tokens (e.g. "Os" + "do") strongly
    # signals a foreign title; one alone is too risky (English uses
    # some of these too — e.g. "Le" in author names).
    return non_en_hits < 2


_EDITORIAL_VARIANT_RE = re.compile(
    r"(?ix)"
    r"(?:^|[\s,(])"  # boundary
    r"(?:"
    r"part\s+(?:one|two|three|four|five|\d+)"  # split editions
    r"|dramatized\s+adaptation"
    r"|audio\s+edition|audiobook(?:\s+edition)?"
    r"|illustrated\s+edition|deluxe\s+edition"
    r"|\d+\s+of\s+\d+"  # "(3 of 5)"
    r")"
)


def _is_editorial_variant(title: str) -> bool:
    """True if the title looks like a split/audio/dramatized edition.

    These are real Hardcover entries at fractional positions (e.g. 1.1,
    1.2) that aren't separate books — they're alternate packagings of
    the same book. Including them as series_entries adds noise: a 5-book
    series like Stormlight balloons to 25 entries because each main
    book has split editions + dramatized adaptations + early drafts.
    """
    if not title:
        return False
    if _EDITORIAL_VARIANT_RE.search(title):
        return True
    # Sanderson's early-draft "Prime" titles — match only as full word.
    if re.search(r"\bPrime\b", title):
        return True
    return False


def dedup_series_books(raw_entries: list[dict]) -> list[dict]:
    """Pick one book per position from raw HC entries.

    Excludes compilations, null positions, and editorial variants
    (Part 1/Part 2 split editions, dramatized adaptations, Prime
    drafts, audio editions). At each position, prefers English titles
    (by character set), then picks the entry with the highest
    ratings_count.

    Returns list of {position, title, author, hardcover_book_id}.
    """
    # Pre-pass: if ANY entry is English, drop the non-English ones
    # entirely. Otherwise we'd keep foreign-language duplicates at
    # fractional positions (e.g. "Os Arquivos do Semideus" PT at 4.5
    # while the English "Demigod Files" is at 3.5) which renders as
    # bogus ghost entries the user has no way to acquire.
    any_english = any(
        _is_likely_english(e.get("title", "")) for e in raw_entries
    )

    by_position: dict[float, dict] = {}
    for entry in raw_entries:
        if entry.get("compilation"):
            continue
        pos = entry.get("position")
        if pos is None:
            continue
        if _is_editorial_variant(entry.get("title", "")):
            continue
        if any_english and not _is_likely_english(entry.get("title", "")):
            continue  # drop foreign-language duplicates

        existing = by_position.get(pos)
        if existing is None:
            by_position[pos] = entry
            continue

        new_eng = _is_likely_english(entry["title"])
        old_eng = _is_likely_english(existing["title"])

        if new_eng and not old_eng:
            by_position[pos] = entry
        elif (
            new_eng == old_eng
            and entry["ratings_count"] > existing["ratings_count"]
        ):
            by_position[pos] = entry

    result = sorted(
        by_position.values(), key=lambda e: e["position"]
    )
    return [
        {
            "position": r["position"],
            "title": r["title"],
            "author": r.get("author", ""),
            "hardcover_book_id": r.get("hardcover_book_id"),
        }
        for r in result
    ]


# --- Title normalization and matching ---


_ROMAN_MAP = {
    "i": "1", "ii": "2", "iii": "3", "iv": "4",
    "v": "5", "vi": "6", "vii": "7", "viii": "8",
    "ix": "9", "x": "10", "xi": "11", "xii": "12",
    "xiii": "13", "xiv": "14", "xv": "15", "xvi": "16",
    "xvii": "17", "xviii": "18", "xix": "19", "xx": "20",
}


def _roman_to_arabic(match: re.Match) -> str:
    """Replace a roman numeral match with arabic."""
    word = match.group(0).lower()
    return _ROMAN_MAP.get(word, word)


def strip_diacritics(text: str) -> str:
    """Replace accented characters with ASCII equivalents.

    Uses Unicode NFKD decomposition to strip combining marks
    (e.g. Shogun from Shōgun, Tai-Pan from Tai-Pan).
    """
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def normalize_title(title: str) -> str:
    """Normalize a title for comparison.

    Strips diacritics, subtitles (after : or -), part/volume
    suffixes, leading articles, replaces hyphens with spaces,
    converts roman numerals to arabic, removes non-alphanumeric.
    """
    # Strip diacritics (Shogun from Shogun, etc.)
    title = strip_diacritics(title)
    # Strip subtitle (after colon, em-dash, or spaced dash)
    title = re.split(r"[:\u2014]|\s-\s", title)[0]
    title = title.strip().lower()
    # Strip "Part N (of M)" and "Volume N" suffixes
    title = re.sub(
        r"\s+part\s+\d+(\s+of\s+\d+)?$", "", title
    )
    title = re.sub(r"\s+vol(ume)?\.?\s+\d+$", "", title)
    # Strip leading articles
    title = re.sub(r"^(the|a|an)\s+", "", title)
    # Replace hyphens with spaces before stripping punctuation
    title = title.replace("-", " ")
    # Remove non-alphanumeric (keep spaces)
    title = re.sub(r"[^a-z0-9\s]", "", title)
    # Collapse whitespace
    title = re.sub(r"\s+", " ", title).strip()
    # Convert roman numerals to arabic (whole words only)
    roman_pattern = (
        r"\b(" + "|".join(_ROMAN_MAP.keys()) + r")\b"
    )
    title = re.sub(roman_pattern, _roman_to_arabic, title)
    return title


def _fuzzy_ratio(a: str, b: str) -> float:
    """SequenceMatcher ratio between two strings."""
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _match_score(a: str, b: str) -> float:
    """Score how well two normalized titles match.

    First checks if the shorter title appears as whole words
    in the longer title (containment). This handles cases like
    "tai pan" inside "james clavells tai pan" where fuzzy
    matching alone fails due to the author-name prefix.

    For non-contained titles, combines fuzzy ratio with a
    length penalty so that similar-length titles score higher
    and short titles don't false-match against each other.
    """
    if not a or not b:
        return 0.0
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    # Whole-word containment: strong match signal
    pattern = r"\b" + re.escape(shorter) + r"\b"
    if re.search(pattern, longer):
        return 0.9
    # Fuzzy ratio with length penalty
    fuzzy = SequenceMatcher(None, a, b).ratio()
    len_ratio = len(shorter) / len(longer)
    return fuzzy * (0.7 + 0.3 * len_ratio)


def match_books(
    hc_books: list[dict], library_books: list[dict]
) -> list[dict]:
    """Match Hardcover books against library books.

    For each Hardcover book, tries to find a matching library
    book using increasingly fuzzy strategies:
    1. Exact title match (case-insensitive, stripped)
    2. Normalized match (strip subtitles, diacritics, articles,
       roman numerals, hyphens, part/volume suffixes)
    3. Fuzzy match (combined score > 0.75 on normalized
       titles, with containment bonus and length weighting)

    Each library book can only match once. Returns hc_books
    annotated with book_id (int or None) and status.
    """
    remaining = list(library_books)

    def _pop_match(lib_book: dict) -> None:
        """Remove a matched library book from candidates."""
        remaining[:] = [
            lb for lb in remaining if lb["id"] != lib_book["id"]
        ]

    exact_map: dict[str, dict] = {}
    normalized_map: dict[str, dict] = {}
    for lb in remaining:
        key = lb["title"].strip().lower()
        exact_map.setdefault(key, lb)
        norm_key = normalize_title(lb["title"])
        normalized_map.setdefault(norm_key, lb)

    result = []
    for hc in hc_books:
        matched_id = None
        hc_title = hc["title"]

        # 1. Exact match
        exact_key = hc_title.strip().lower()
        lb = exact_map.get(exact_key)
        if lb and lb in remaining:
            matched_id = lb["id"]
            _pop_match(lb)
        else:
            # 2. Normalized match
            norm_key = normalize_title(hc_title)
            lb = normalized_map.get(norm_key)
            if lb and lb in remaining:
                matched_id = lb["id"]
                _pop_match(lb)
            else:
                # 3. Fuzzy match with length weighting
                best_score = 0.0
                best_lb = None
                for lb in remaining:
                    score = _match_score(
                        norm_key,
                        normalize_title(lb["title"]),
                    )
                    if score > best_score:
                        best_score = score
                        best_lb = lb
                if best_score > 0.75 and best_lb:
                    matched_id = best_lb["id"]
                    _pop_match(best_lb)

        entry = dict(hc)
        entry["book_id"] = matched_id
        entry["status"] = "linked" if matched_id else "unlinked"
        result.append(entry)

    return result
