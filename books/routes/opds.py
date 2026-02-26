"""OPDS Catalog Feed routes for e-reader access."""

import logging
from datetime import datetime, timezone
from urllib.parse import urlencode
from xml.etree.ElementTree import Element, SubElement, tostring

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response

from ..helpers import db
from ..helpers.auth import basic_auth_user
from ..helpers.db import DATA_DIR

log = logging.getLogger(__name__)
router = APIRouter(prefix="/opds", tags=["opds"])

ATOM_NS = "http://www.w3.org/2005/Atom"
DC_NS = "http://purl.org/dc/terms/"
OPDS_NS = "http://opds-spec.org/2010/catalog"
OPENSEARCH_NS = "http://a9.com/-/spec/opensearch/1.1/"

MIME_NAV = (
    "application/atom+xml;profile=opds-catalog;kind=navigation"
)
MIME_ACQ = (
    "application/atom+xml;profile=opds-catalog;kind=acquisition"
)

PAGE_SIZE = 2000


# --- XML helpers ---


def _serialize(root: Element) -> str:
    """Serialize an ElementTree element to XML string."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + tostring(root, encoding="unicode")
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def _make_feed(
    title: str,
    feed_id: str,
    entries: list[Element],
    links: list[dict],
) -> Element:
    """Build an Atom feed element with OPDS namespaces."""
    feed = Element("feed", xmlns=ATOM_NS)
    feed.set("xmlns:dc", DC_NS)
    feed.set("xmlns:opds", OPDS_NS)

    SubElement(feed, "id").text = feed_id
    SubElement(feed, "title").text = title
    SubElement(feed, "updated").text = _now_iso()

    for link in links:
        attrs = {"href": link["href"], "rel": link["rel"]}
        if "type" in link:
            attrs["type"] = link["type"]
        if "title" in link:
            attrs["title"] = link["title"]
        SubElement(feed, "link", **attrs)

    for entry in entries:
        feed.append(entry)

    return feed


def _make_nav_entry(
    title: str,
    href: str,
    content: str,
    entry_id: str | None = None,
) -> Element:
    """Build a navigation entry pointing to a sub-feed."""
    entry = Element("entry")
    SubElement(entry, "title").text = title
    SubElement(entry, "id").text = entry_id or href
    SubElement(entry, "updated").text = _now_iso()
    SubElement(entry, "content", type="text").text = content
    SubElement(
        entry, "link",
        href=href,
        rel="subsection",
        type=MIME_NAV,
    )
    return entry


def _make_book_entry(
    book: dict,
    user_id: int,
) -> Element:
    """Build an acquisition entry for a book."""
    entry = Element("entry")
    SubElement(entry, "title").text = book["title"]
    SubElement(entry, "id").text = (
        f"urn:books:{user_id}:{book['id']}"
    )
    SubElement(entry, "updated").text = (
        book.get("date_added") or _now_iso()
    )

    if book.get("authors"):
        author_el = SubElement(entry, "author")
        SubElement(author_el, "name").text = book["authors"]

    if book.get("description"):
        SubElement(
            entry, "content", type="text"
        ).text = book["description"]

    if book.get("series"):
        summary = f"Series: {book['series']}"
        if book.get("series_index"):
            summary += f" #{book['series_index']}"
        SubElement(
            entry, "summary", type="text"
        ).text = summary

    # Acquisition link (EPUB download)
    if book.get("file_path"):
        SubElement(
            entry, "link",
            href=f"/opds/download/{book['id']}",
            rel="http://opds-spec.org/acquisition",
            type="application/epub+zip",
        )

    # Cover image link
    if book.get("cover_filename"):
        cover_url = (
            f"/covers/{user_id}/{book['cover_filename']}"
        )
        SubElement(
            entry, "link",
            href=cover_url,
            rel="http://opds-spec.org/image",
            type="image/jpeg",
        )
        SubElement(
            entry, "link",
            href=cover_url,
            rel="http://opds-spec.org/image/thumbnail",
            type="image/jpeg",
        )

    return entry


# --- Filter helpers ---


def _parse_filters(
    status: str | None,
    rated: str | None,
    rating: int | None,
    favorite: str | None,
    letter: str | None = None,
) -> dict:
    """Parse query params into a filter dict."""
    filters = {}
    if status in ("unread", "read", "reading"):
        filters["status"] = status
    if rated in ("yes", "no"):
        filters["rated"] = rated
    if rating is not None and 1 <= rating <= 5:
        filters["rating"] = rating
    if favorite == "yes":
        filters["favorite"] = "yes"
    if letter is not None:
        filters["letter"] = letter
    return filters


def _db_filter_kwargs(filters: dict) -> dict:
    """Convert filter dict to kwargs for get_books/count_books."""
    kwargs: dict = {}
    if "status" in filters:
        kwargs["reading_status"] = filters["status"]
    if "rated" in filters:
        kwargs["rated"] = filters["rated"] == "yes"
    if "rating" in filters:
        kwargs["min_rating"] = filters["rating"]
        kwargs["max_rating"] = filters["rating"]
    if "favorite" in filters:
        kwargs["is_favorite"] = True
    if "letter" in filters:
        kwargs["letter"] = filters["letter"]
    return kwargs


def _build_url(base_path: str, filters: dict, **extra) -> str:
    """Build URL with filter params as query string."""
    params = {}
    for key in (
        "status", "rated", "rating", "favorite", "letter",
    ):
        if key in filters:
            params[key] = filters[key]
    params.update(extra)
    if params:
        return f"{base_path}?{urlencode(params)}"
    return base_path


def _build_filter_entries(
    base_path: str,
    current_filters: dict,
    user_id: int,
    show_letter: bool = True,
    count_by_letter_fn=None,
    extra_db_kwargs: dict | None = None,
    count_fn=None,
) -> list[Element]:
    """Generate nav entries for available sub-filters.

    Args:
        extra_db_kwargs: Additional DB kwargs merged into every
            count query (e.g. {"reading_status": "reading"}).
        count_fn: Alternative count function for non-letter
            filters. Signature: count_fn(user_id, **kwargs).
            Defaults to db.count_books(user_id, is_owned=True).
    """
    entries = []
    extra = extra_db_kwargs or {}
    base_kwargs = {**_db_filter_kwargs(current_filters), **extra}

    def _count(kwargs: dict) -> int:
        merged = {**kwargs, **extra}
        if count_fn is not None:
            return count_fn(user_id, **merged)
        return db.count_books(
            user_id, is_owned=True, **merged,
        )

    # Status filters (skip if status already set or if
    # extra_db_kwargs already constrains reading_status)
    if ("status" not in current_filters
            and "reading_status" not in extra):
        for label, val in [
            ("Unread", "unread"),
            ("Read", "read"),
            ("Currently Reading", "reading"),
        ]:
            merged = {**current_filters, "status": val}
            count = _count(_db_filter_kwargs(merged))
            if count > 0:
                entries.append(_make_nav_entry(
                    f"{label} ({count})",
                    _build_url(base_path, merged),
                    f"Filter to {label.lower()} books",
                ))

    # Rated/unrated (if rated/rating not set)
    if ("rated" not in current_filters
            and "rating" not in current_filters):
        for label, val in [
            ("Rated", "yes"),
            ("Unrated", "no"),
        ]:
            merged = {**current_filters, "rated": val}
            count = _count(_db_filter_kwargs(merged))
            if count > 0:
                entries.append(_make_nav_entry(
                    f"{label} ({count})",
                    _build_url(base_path, merged),
                    f"Filter to {label.lower()} books",
                ))

    # Rating 1-5 (only if rated=yes)
    if current_filters.get("rated") == "yes":
        for star in range(5, 0, -1):
            merged = {
                k: v for k, v in current_filters.items()
                if k != "rated"
            }
            merged["rating"] = star
            count = _count(_db_filter_kwargs(merged))
            if count > 0:
                label = f"{'*' * star} ({count})"
                entries.append(_make_nav_entry(
                    label,
                    _build_url(base_path, merged),
                    f"Filter to {star}-star books",
                ))

    # Favorites (if not set)
    if "favorite" not in current_filters:
        merged = {**current_filters, "favorite": "yes"}
        count = _count(_db_filter_kwargs(merged))
        if count > 0:
            entries.append(_make_nav_entry(
                f"Favorites ({count})",
                _build_url(base_path, merged),
                "Filter to favorite books",
            ))

    # Letter filter (A-Z, #) when > 50 items and not set
    if show_letter and "letter" not in current_filters:
        # Strip letter from kwargs for the by-letter query
        letter_kwargs = {
            k: v for k, v in base_kwargs.items()
            if k != "letter"
        }
        if count_by_letter_fn is not None:
            counts = count_by_letter_fn(
                user_id, **letter_kwargs,
            )
            total = sum(counts.values())
        else:
            total = _count(
                {k: v for k, v in letter_kwargs.items()
                 if k not in extra},
            )
            counts = None
        if total > 50:
            if counts is None:
                counts = db.count_books_by_letter(
                    user_id, is_owned=True,
                    **letter_kwargs,
                )
            if "#" in counts:
                entries.append(_make_nav_entry(
                    f"# ({counts['#']})",
                    _build_url(
                        base_path,
                        {**current_filters, "letter": "#"},
                    ),
                    "Titles starting with a number",
                ))
            for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                if ch in counts:
                    entries.append(_make_nav_entry(
                        f"{ch} ({counts[ch]})",
                        _build_url(
                            base_path,
                            {**current_filters,
                             "letter": ch},
                        ),
                        f"Titles starting with {ch}",
                    ))

    return entries


def _build_show_entry(
    base_path: str,
    current_filters: dict,
    count: int,
    label: str = "Show Books",
) -> Element:
    """Build the 'Show N Books' entry at the top."""
    return _make_nav_entry(
        f"{label} ({count})",
        _build_url(base_path, current_filters, show="1"),
        f"View {count} items",
    )


def _nav_response(
    title: str,
    feed_id: str,
    base_path: str,
    current_filters: dict,
    user_id: int,
    entries: list[Element],
) -> Response:
    """Build a standard nav feed response with links."""
    links = [
        {
            "href": _build_url(base_path, current_filters),
            "rel": "self",
            "type": MIME_NAV,
        },
        {
            "href": "/opds/",
            "rel": "start",
            "type": MIME_NAV,
        },
    ]
    feed = _make_feed(title, feed_id, entries, links)
    return Response(
        content=_serialize(feed), media_type=MIME_NAV
    )


def _acq_response(
    title: str,
    feed_id: str,
    self_href: str,
    books: list[dict],
    user_id: int,
) -> Response:
    """Build a standard acquisition feed response."""
    entries = [
        _make_book_entry(b, user_id) for b in books
    ]
    links = [
        {"href": self_href, "rel": "self", "type": MIME_ACQ},
        {"href": "/opds/", "rel": "start", "type": MIME_NAV},
    ]
    feed = _make_feed(title, feed_id, entries, links)
    return Response(
        content=_serialize(feed), media_type=MIME_ACQ
    )


# --- Route endpoints ---


@router.get("/")
def root_catalog(user: basic_auth_user) -> Response:
    """Root OPDS navigation feed."""
    user_id = user["user_id"]
    total = db.count_books(user_id, is_owned=True)

    entries = [
        _make_nav_entry(
            f"All Books ({total})",
            "/opds/all",
            "Browse all books in your library",
        ),
        _make_nav_entry(
            "By Series",
            "/opds/series",
            "Browse books by series",
        ),
        _make_nav_entry(
            "By Author",
            "/opds/authors",
            "Browse books by author",
        ),
        _make_nav_entry(
            "Recently Added",
            "/opds/recent",
            "Books ordered by date added",
        ),
        _make_nav_entry(
            "Currently Reading",
            "/opds/reading",
            "Books you are currently reading",
        ),
        _make_nav_entry(
            "Recently Read",
            "/opds/activity",
            "Books ordered by date finished",
        ),
    ]
    links = [
        {"href": "/opds/", "rel": "self", "type": MIME_NAV},
        {"href": "/opds/", "rel": "start", "type": MIME_NAV},
        {
            "href": "/opds/opensearch.xml",
            "rel": "search",
            "type": "application/opensearchdescription+xml",
        },
    ]
    feed = _make_feed(
        "Books Library",
        f"urn:books:{user_id}:root",
        entries,
        links,
    )
    return Response(
        content=_serialize(feed), media_type=MIME_NAV
    )


@router.get("/all")
def all_books(
    user: basic_auth_user,
    status: str | None = Query(default=None),
    rated: str | None = Query(default=None),
    rating: int | None = Query(default=None, ge=1, le=5),
    favorite: str | None = Query(default=None),
    letter: str | None = Query(default=None),
    show: str | None = Query(default=None),
) -> Response:
    """All books - nav feed with filters, or acquisition."""
    user_id = user["user_id"]
    filters = _parse_filters(
        status, rated, rating, favorite, letter,
    )
    db_kwargs = _db_filter_kwargs(filters)

    if show == "1":
        books = db.get_books(
            user_id, is_owned=True,
            sort="title", order="asc",
            limit=PAGE_SIZE, **db_kwargs,
        )
        return _acq_response(
            "All Books",
            f"urn:books:{user_id}:all",
            _build_url("/opds/all", filters, show="1"),
            books, user_id,
        )

    # Navigation feed
    total = db.count_books(
        user_id, is_owned=True, **db_kwargs,
    )
    entries = [
        _build_show_entry("/opds/all", filters, total),
    ]
    entries.extend(
        _build_filter_entries("/opds/all", filters, user_id)
    )
    return _nav_response(
        "All Books",
        f"urn:books:{user_id}:all",
        "/opds/all", filters, user_id, entries,
    )


@router.get("/series")
def series_list(
    user: basic_auth_user,
    status: str | None = Query(default=None),
    rated: str | None = Query(default=None),
    rating: int | None = Query(default=None, ge=1, le=5),
    favorite: str | None = Query(default=None),
    letter: str | None = Query(default=None),
    show: str | None = Query(default=None),
) -> Response:
    """Series listing - nav with filters or series list."""
    user_id = user["user_id"]
    filters = _parse_filters(
        status, rated, rating, favorite, letter,
    )
    db_kwargs = _db_filter_kwargs(filters)

    if show == "1":
        # Show series listing (filtered)
        series = db.get_filtered_series(user_id, **db_kwargs)
        entries = [
            _make_nav_entry(
                f"{s['series']} ({s['count']})",
                _build_url(
                    f"/opds/series/{s['series_link_id']}",
                    filters,
                ),
                f"{s['count']} books",
                entry_id=(
                    f"urn:books:{user_id}"
                    f":series:{s['series_link_id']}"
                ),
            )
            for s in series
        ]
        return _nav_response(
            "Series",
            f"urn:books:{user_id}:series",
            "/opds/series", filters, user_id, entries,
        )

    # Navigation feed with filter options
    series = db.get_filtered_series(user_id, **db_kwargs)
    total = len(series)
    entries = [
        _build_show_entry(
            "/opds/series", filters, total,
            label="Show Series",
        ),
    ]
    def _count_series(user_id, **kwargs):
        return len(db.get_filtered_series(user_id, **kwargs))

    entries.extend(
        _build_filter_entries(
            "/opds/series", filters, user_id,
            count_by_letter_fn=db.count_series_by_letter,
            count_fn=_count_series,
        )
    )
    return _nav_response(
        "Series",
        f"urn:books:{user_id}:series",
        "/opds/series", filters, user_id, entries,
    )


@router.get("/series/{series_link_id}")
def series_books(
    series_link_id: int,
    user: basic_auth_user,
    status: str | None = Query(default=None),
    rated: str | None = Query(default=None),
    rating: int | None = Query(default=None, ge=1, le=5),
    favorite: str | None = Query(default=None),
) -> Response:
    """Books in a series as acquisition feed."""
    user_id = user["user_id"]
    filters = _parse_filters(status, rated, rating, favorite)
    db_kwargs = _db_filter_kwargs(filters)

    all_books_in_series = db.get_series_books(
        user_id, series_link_id,
    )
    if not all_books_in_series:
        raise HTTPException(
            status_code=404, detail="Series not found"
        )

    # Apply filters in Python (get_series_books doesn't
    # support them natively)
    books = _apply_filters(all_books_in_series, db_kwargs)
    series_name = all_books_in_series[0].get(
        "series", "Series"
    )

    return _acq_response(
        series_name,
        f"urn:books:{user_id}:series:{series_link_id}",
        _build_url(
            f"/opds/series/{series_link_id}", filters,
        ),
        books, user_id,
    )


@router.get("/authors")
def authors_list(
    user: basic_auth_user,
    status: str | None = Query(default=None),
    rated: str | None = Query(default=None),
    rating: int | None = Query(default=None, ge=1, le=5),
    favorite: str | None = Query(default=None),
    letter: str | None = Query(default=None),
    show: str | None = Query(default=None),
) -> Response:
    """Author listing - nav with filters or author list."""
    user_id = user["user_id"]
    filters = _parse_filters(
        status, rated, rating, favorite, letter,
    )
    db_kwargs = _db_filter_kwargs(filters)

    if show == "1":
        # Show author listing (filtered)
        authors = db.get_distinct_authors(
            user_id, **db_kwargs,
        )
        entries = [
            _make_nav_entry(
                f"{a['authors']} ({a['count']})",
                _build_url(
                    f"/opds/authors/{_author_slug(a['authors'])}",
                    filters,
                ),
                f"{a['count']} books",
                entry_id=(
                    f"urn:books:{user_id}"
                    f":author:{a['authors']}"
                ),
            )
            for a in authors
        ]
        return _nav_response(
            "Authors",
            f"urn:books:{user_id}:authors",
            "/opds/authors", filters, user_id, entries,
        )

    # Navigation feed with filter options
    authors = db.get_distinct_authors(
        user_id, **db_kwargs,
    )
    total = len(authors)
    entries = [
        _build_show_entry(
            "/opds/authors", filters, total,
            label="Show Authors",
        ),
    ]
    def _count_authors(user_id, **kwargs):
        return len(
            db.get_distinct_authors(user_id, **kwargs)
        )

    entries.extend(
        _build_filter_entries(
            "/opds/authors", filters, user_id,
            count_by_letter_fn=db.count_authors_by_letter,
            count_fn=_count_authors,
        )
    )
    return _nav_response(
        "Authors",
        f"urn:books:{user_id}:authors",
        "/opds/authors", filters, user_id, entries,
    )


@router.get("/authors/{author_name:path}")
def author_books(
    author_name: str,
    user: basic_auth_user,
    status: str | None = Query(default=None),
    rated: str | None = Query(default=None),
    rating: int | None = Query(default=None, ge=1, le=5),
    favorite: str | None = Query(default=None),
) -> Response:
    """Books by an author as acquisition feed."""
    user_id = user["user_id"]
    filters = _parse_filters(status, rated, rating, favorite)
    db_kwargs = _db_filter_kwargs(filters)

    # Resolve slug back to actual author name
    all_authors = db.get_distinct_authors(user_id)
    real_name = None
    for a in all_authors:
        if _author_slug(a["authors"]) == author_name:
            real_name = a["authors"]
            break
    if real_name is None:
        raise HTTPException(
            status_code=404, detail="Author not found"
        )

    # Get books by this author with filters
    books = db.get_books(
        user_id, is_owned=True,
        sort="title", order="asc",
        limit=PAGE_SIZE, **db_kwargs,
    )
    books = [
        b for b in books if b.get("authors") == real_name
    ]

    return _acq_response(
        real_name,
        f"urn:books:{user_id}:author:{real_name}",
        _build_url(
            f"/opds/authors/{author_name}", filters,
        ),
        books, user_id,
    )


@router.get("/recent")
def recent_books(
    user: basic_auth_user,
    status: str | None = Query(default=None),
    rated: str | None = Query(default=None),
    rating: int | None = Query(default=None, ge=1, le=5),
    favorite: str | None = Query(default=None),
    letter: str | None = Query(default=None),
    show: str | None = Query(default=None),
) -> Response:
    """Recently added - nav with filters or book list."""
    user_id = user["user_id"]
    filters = _parse_filters(
        status, rated, rating, favorite, letter,
    )
    db_kwargs = _db_filter_kwargs(filters)

    if show == "1":
        books = db.get_books(
            user_id, is_owned=True,
            sort="date_added", order="desc",
            limit=PAGE_SIZE, **db_kwargs,
        )
        return _acq_response(
            "Recently Added",
            f"urn:books:{user_id}:recent",
            _build_url("/opds/recent", filters, show="1"),
            books, user_id,
        )

    total = db.count_books(
        user_id, is_owned=True, **db_kwargs,
    )
    entries = [
        _build_show_entry("/opds/recent", filters, total),
    ]
    entries.extend(
        _build_filter_entries(
            "/opds/recent", filters, user_id,
        )
    )
    return _nav_response(
        "Recently Added",
        f"urn:books:{user_id}:recent",
        "/opds/recent", filters, user_id, entries,
    )


@router.get("/reading")
def reading_books(
    user: basic_auth_user,
    status: str | None = Query(default=None),
    rated: str | None = Query(default=None),
    rating: int | None = Query(default=None, ge=1, le=5),
    favorite: str | None = Query(default=None),
    letter: str | None = Query(default=None),
    show: str | None = Query(default=None),
) -> Response:
    """Currently reading - nav with filters or book list."""
    user_id = user["user_id"]
    filters = _parse_filters(
        status, rated, rating, favorite, letter,
    )
    db_kwargs = _db_filter_kwargs(filters)

    if show == "1":
        books = db.get_books(
            user_id, is_owned=True,
            reading_status="reading",
            sort="title", order="asc",
            limit=PAGE_SIZE,
            **{k: v for k, v in db_kwargs.items()
               if k != "reading_status"},
        )
        return _acq_response(
            "Currently Reading",
            f"urn:books:{user_id}:reading",
            _build_url(
                "/opds/reading", filters, show="1",
            ),
            books, user_id,
        )

    reading_kwargs = {**db_kwargs}
    if "reading_status" not in reading_kwargs:
        reading_kwargs["reading_status"] = "reading"
    total = db.count_books(
        user_id, is_owned=True, **reading_kwargs,
    )
    entries = [
        _build_show_entry(
            "/opds/reading", filters, total,
        ),
    ]
    entries.extend(
        _build_filter_entries(
            "/opds/reading", filters, user_id,
            extra_db_kwargs={"reading_status": "reading"},
        )
    )
    return _nav_response(
        "Currently Reading",
        f"urn:books:{user_id}:reading",
        "/opds/reading", filters, user_id, entries,
    )


@router.get("/activity")
def activity_books(
    user: basic_auth_user,
    status: str | None = Query(default=None),
    rated: str | None = Query(default=None),
    rating: int | None = Query(default=None, ge=1, le=5),
    favorite: str | None = Query(default=None),
    letter: str | None = Query(default=None),
    show: str | None = Query(default=None),
) -> Response:
    """Recently read - nav with filters or book list."""
    user_id = user["user_id"]
    filters = _parse_filters(
        status, rated, rating, favorite, letter,
    )
    db_kwargs = _db_filter_kwargs(filters)

    if show == "1":
        # Only books with a date_finished
        books = db.get_books(
            user_id, is_owned=True,
            reading_status="read",
            sort="date_finished", order="desc",
            limit=PAGE_SIZE,
            **{k: v for k, v in db_kwargs.items()
               if k != "reading_status"},
        )
        return _acq_response(
            "Recently Read",
            f"urn:books:{user_id}:activity",
            _build_url(
                "/opds/activity", filters, show="1",
            ),
            books, user_id,
        )

    # For activity, default scope is read books
    activity_kwargs = {**db_kwargs}
    if "reading_status" not in activity_kwargs:
        activity_kwargs["reading_status"] = "read"
    total = db.count_books(
        user_id, is_owned=True, **activity_kwargs,
    )
    entries = [
        _build_show_entry(
            "/opds/activity", filters, total,
        ),
    ]
    entries.extend(
        _build_filter_entries(
            "/opds/activity", filters, user_id,
            extra_db_kwargs={"reading_status": "read"},
        )
    )
    return _nav_response(
        "Recently Read",
        f"urn:books:{user_id}:activity",
        "/opds/activity", filters, user_id, entries,
    )


# --- Existing endpoints (search, opensearch, download) ---


@router.get("/search")
def search_books(
    user: basic_auth_user,
    q: str = Query(..., min_length=1),
) -> Response:
    """Search books acquisition feed."""
    user_id = user["user_id"]

    books = db.get_books(
        user_id, q=q, is_owned=True, limit=PAGE_SIZE
    )
    return _acq_response(
        f"Search: {q}",
        f"urn:books:{user_id}:search:{q}",
        f"/opds/search?q={q}",
        books, user_id,
    )


@router.get("/opensearch.xml")
def opensearch_description() -> Response:
    """OpenSearch description document for OPDS search."""
    root = Element(
        "OpenSearchDescription",
        xmlns=OPENSEARCH_NS,
    )
    SubElement(root, "ShortName").text = "Books Search"
    SubElement(root, "Description").text = (
        "Search the book library"
    )
    SubElement(
        root, "Url",
        type=MIME_ACQ,
        template="/opds/search?q={searchTerms}",
    )
    return Response(
        content=_serialize(root),
        media_type="application/opensearchdescription+xml",
    )


@router.get("/download/{book_id}")
def download_book(
    book_id: int,
    user: basic_auth_user,
) -> FileResponse:
    """Download an EPUB file via Basic Auth."""
    user_id = user["user_id"]
    book = db.get_book(book_id, user_id)
    if book is None or not book.get("file_path"):
        raise HTTPException(
            status_code=404, detail="File not found"
        )
    file_path = (
        DATA_DIR / "files" / str(user_id) / book["file_path"]
    )
    if not file_path.exists():
        raise HTTPException(
            status_code=404, detail="File missing"
        )
    return FileResponse(
        str(file_path),
        media_type="application/epub+zip",
        filename=f"{book['title']}.epub",
    )


# --- Utility helpers ---


def _author_slug(name: str) -> str:
    """Convert author name to a URL-safe slug."""
    return (
        name.lower()
        .replace(" ", "-")
        .replace(",", "")
        .replace(".", "")
    )


def _apply_filters(
    books: list[dict], db_kwargs: dict
) -> list[dict]:
    """Apply filter kwargs to a list of book dicts."""
    result = books
    if "reading_status" in db_kwargs:
        status = db_kwargs["reading_status"]
        result = [
            b for b in result
            if b.get("reading_status") == status
        ]
    if "rated" in db_kwargs:
        if db_kwargs["rated"]:
            result = [
                b for b in result
                if b.get("rating") is not None
            ]
        else:
            result = [
                b for b in result
                if b.get("rating") is None
            ]
    if "min_rating" in db_kwargs:
        val = db_kwargs["min_rating"]
        result = [
            b for b in result
            if b.get("rating") is not None
            and b["rating"] >= val
        ]
    if "max_rating" in db_kwargs:
        val = db_kwargs["max_rating"]
        result = [
            b for b in result
            if b.get("rating") is not None
            and b["rating"] <= val
        ]
    if "is_favorite" in db_kwargs:
        result = [
            b for b in result
            if b.get("is_favorite") == 1
        ]
    return result
