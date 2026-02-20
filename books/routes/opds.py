"""OPDS Catalog Feed routes for e-reader access."""

import logging
from datetime import datetime, timezone
from xml.etree.ElementTree import Element, SubElement, tostring

from fastapi import APIRouter, HTTPException, Query, Request
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

PAGE_SIZE = 100


def _serialize(root: Element) -> str:
    """Serialize an ElementTree element to XML string."""
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + tostring(
        root, encoding="unicode"
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
    base_url: str,
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
        SubElement(entry, "summary", type="text").text = summary

    # Acquisition link (EPUB download)
    if book.get("file_path"):
        SubElement(
            entry, "link",
            href=f"{base_url}/opds/download/{book['id']}",
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


def _base_url(request: Request) -> str:
    """Get the base URL from the request for absolute links."""
    return str(request.base_url).rstrip("/")


@router.get("/")
def root_catalog(
    user: basic_auth_user,
    request: Request,
) -> Response:
    """Root OPDS navigation feed."""
    base = _base_url(request)
    entries = [
        _make_nav_entry(
            "All Books",
            f"{base}/opds/all",
            "Browse all books in your library",
        ),
        _make_nav_entry(
            "Series",
            f"{base}/opds/series",
            "Browse books by series",
        ),
    ]
    links = [
        {
            "href": f"{base}/opds/",
            "rel": "self",
            "type": MIME_NAV,
        },
        {
            "href": f"{base}/opds/",
            "rel": "start",
            "type": MIME_NAV,
        },
        {
            "href": f"{base}/opds/opensearch.xml",
            "rel": "search",
            "type": "application/opensearchdescription+xml",
        },
    ]
    feed = _make_feed(
        "Books Library",
        f"urn:books:{user['user_id']}:root",
        entries,
        links,
    )
    return Response(
        content=_serialize(feed), media_type=MIME_NAV
    )


@router.get("/all")
def all_books(
    user: basic_auth_user,
    request: Request,
    offset: int = Query(default=0, ge=0),
) -> Response:
    """All books acquisition feed with pagination."""
    base = _base_url(request)
    user_id = user["user_id"]

    books = db.get_books(
        user_id,
        is_owned=True,
        sort="title",
        order="asc",
        limit=PAGE_SIZE,
        offset=offset,
    )
    total = db.count_books(user_id, is_owned=True)

    entries = [
        _make_book_entry(b, user_id, base) for b in books
    ]
    links = [
        {
            "href": f"{base}/opds/all?offset={offset}",
            "rel": "self",
            "type": MIME_ACQ,
        },
        {
            "href": f"{base}/opds/",
            "rel": "start",
            "type": MIME_NAV,
        },
    ]
    if offset + PAGE_SIZE < total:
        links.append({
            "href": (
                f"{base}/opds/all"
                f"?offset={offset + PAGE_SIZE}"
            ),
            "rel": "next",
            "type": MIME_ACQ,
        })

    feed = _make_feed(
        "All Books",
        f"urn:books:{user_id}:all",
        entries,
        links,
    )
    return Response(
        content=_serialize(feed), media_type=MIME_ACQ
    )


@router.get("/series")
def series_list(
    user: basic_auth_user,
    request: Request,
) -> Response:
    """Series listing as navigation feed."""
    base = _base_url(request)
    user_id = user["user_id"]

    series = db.get_series_list(user_id)
    entries = [
        _make_nav_entry(
            s["series"],
            f"{base}/opds/series/{s['series_link_id']}",
            f"{s['total_books']} books",
            entry_id=(
                f"urn:books:{user_id}"
                f":series:{s['series_link_id']}"
            ),
        )
        for s in series
    ]
    links = [
        {
            "href": f"{base}/opds/series",
            "rel": "self",
            "type": MIME_NAV,
        },
        {
            "href": f"{base}/opds/",
            "rel": "start",
            "type": MIME_NAV,
        },
    ]
    feed = _make_feed(
        "Series",
        f"urn:books:{user_id}:series",
        entries,
        links,
    )
    return Response(
        content=_serialize(feed), media_type=MIME_NAV
    )


@router.get("/series/{series_link_id}")
def series_books(
    series_link_id: int,
    user: basic_auth_user,
    request: Request,
) -> Response:
    """Books in a series as acquisition feed."""
    base = _base_url(request)
    user_id = user["user_id"]

    books = db.get_series_books(user_id, series_link_id)
    if not books:
        raise HTTPException(
            status_code=404, detail="Series not found"
        )

    series_name = books[0].get("series", "Series")
    entries = [
        _make_book_entry(b, user_id, base) for b in books
    ]
    links = [
        {
            "href": (
                f"{base}/opds/series/{series_link_id}"
            ),
            "rel": "self",
            "type": MIME_ACQ,
        },
        {
            "href": f"{base}/opds/",
            "rel": "start",
            "type": MIME_NAV,
        },
    ]
    feed = _make_feed(
        series_name,
        f"urn:books:{user_id}:series:{series_link_id}",
        entries,
        links,
    )
    return Response(
        content=_serialize(feed), media_type=MIME_ACQ
    )


@router.get("/search")
def search_books(
    user: basic_auth_user,
    request: Request,
    q: str = Query(..., min_length=1),
) -> Response:
    """Search books acquisition feed."""
    base = _base_url(request)
    user_id = user["user_id"]

    books = db.get_books(
        user_id, q=q, is_owned=True, limit=PAGE_SIZE
    )
    entries = [
        _make_book_entry(b, user_id, base) for b in books
    ]
    links = [
        {
            "href": f"{base}/opds/search?q={q}",
            "rel": "self",
            "type": MIME_ACQ,
        },
        {
            "href": f"{base}/opds/",
            "rel": "start",
            "type": MIME_NAV,
        },
    ]
    feed = _make_feed(
        f"Search: {q}",
        f"urn:books:{user_id}:search:{q}",
        entries,
        links,
    )
    return Response(
        content=_serialize(feed), media_type=MIME_ACQ
    )


@router.get("/opensearch.xml")
def opensearch_description(request: Request) -> Response:
    """OpenSearch description document for OPDS search."""
    base = _base_url(request)
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
        template=f"{base}/opds/search?q={{searchTerms}}",
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
