import logging

import httpx
from decouple import config

log = logging.getLogger(__name__)

GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes"
GOOGLE_BOOKS_API_KEY = config("GOOGLE_BOOKS_API_KEY", default="")
OPEN_LIBRARY_SEARCH = "https://openlibrary.org/search.json"


async def search_google_books(
    query: str, max_results: int = 5
) -> list[dict]:
    """Search Google Books API.

    Raises on HTTP or network errors so callers can capture
    the error message instead of silently getting [].
    """
    params: dict[str, str | int] = {
        "q": query,
        "maxResults": max_results,
    }
    if GOOGLE_BOOKS_API_KEY:
        params["key"] = GOOGLE_BOOKS_API_KEY
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            GOOGLE_BOOKS_URL, params=params
        )
        resp.raise_for_status()
        data = resp.json()

    results = []
    for item in data.get("items", []):
        info = item.get("volumeInfo", {})
        identifiers = {
            i["type"]: i["identifier"]
            for i in info.get("industryIdentifiers", [])
        }
        results.append({
            "title": info.get("title", ""),
            "authors": ", ".join(info.get("authors", [])),
            "description": info.get("description", ""),
            "isbn": identifiers.get(
                "ISBN_13", identifiers.get("ISBN_10", "")
            ),
            "cover_url": info.get("imageLinks", {}).get(
                "thumbnail", ""
            ),
            "published_date": info.get("publishedDate", ""),
            "categories": info.get("categories", []),
        })
    return results


async def search_open_library(
    query: str, max_results: int = 5
) -> list[dict]:
    """Search Open Library API.

    Raises on HTTP or network errors so callers can capture
    the error message instead of silently getting [].
    """
    params = {"q": query, "limit": max_results}
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            OPEN_LIBRARY_SEARCH, params=params
        )
        resp.raise_for_status()
        data = resp.json()

    results = []
    for doc in data.get("docs", []):
        isbns = doc.get("isbn", [])
        results.append({
            "title": doc.get("title", ""),
            "authors": ", ".join(
                doc.get("author_name", [])
            ),
            "isbn": isbns[0] if isbns else "",
            "first_publish_year": doc.get(
                "first_publish_year", ""
            ),
            "cover_id": doc.get("cover_i", ""),
        })
    return results


def extract_epub_metadata(epub_path: str) -> dict:
    try:
        return _extract_via_ebooklib(epub_path)
    except (KeyError, Exception) as exc:
        log.warning(
            "ebooklib failed for %s (%s), using fallback",
            epub_path, exc,
        )
        return _extract_via_zipfile(epub_path)


def _extract_via_ebooklib(epub_path: str) -> dict:
    import ebooklib
    from ebooklib import epub

    book = epub.read_epub(epub_path)

    def get_meta(field: str) -> str:
        values = book.get_metadata("DC", field)
        if values:
            return values[0][0]
        return ""

    title = get_meta("title")
    creators = book.get_metadata("DC", "creator")
    authors = ", ".join(c[0] for c in creators) if creators else ""
    description = get_meta("description")
    identifiers = book.get_metadata("DC", "identifier")
    isbn = ""
    for ident in identifiers:
        val = ident[0]
        attrs = ident[1] if len(ident) > 1 else {}
        scheme = attrs.get(
            "{http://www.idpf.org/2007/opf}scheme", ""
        )
        if scheme.upper() == "ISBN" or (
            val.replace("-", "").isdigit() and len(val) >= 10
        ):
            isbn = val
            break

    subjects = book.get_metadata("DC", "subject")
    tags = [s[0] for s in subjects] if subjects else []

    cover_data = None
    for item in book.get_items_of_type(ebooklib.ITEM_COVER):
        cover_data = item.get_content()
        break
    if cover_data is None:
        for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
            if "cover" in item.get_name().lower():
                cover_data = item.get_content()
                break

    # Series metadata from calibre:series / EPUB3 belongs-to-collection
    series = ""
    series_index = None

    # Try OPF meta tags (calibre:series)
    opf_meta = book.get_metadata("OPF", "meta")
    for entry in opf_meta or []:
        # ebooklib returns (value, attrs) tuples for OPF meta
        attrs = entry[1] if len(entry) > 1 else {}
        name = attrs.get("name", "")
        content = attrs.get("content", "")
        if name == "calibre:series" and content:
            series = content
        elif name == "calibre:series_index" and content:
            try:
                series_index = float(content)
            except (ValueError, TypeError):
                pass

    # EPUB3: belongs-to-collection
    if not series:
        collections = book.get_metadata(
            "http://www.idpf.org/2007/opf", "belongs-to-collection"
        )
        if collections:
            series = collections[0][0]

    return {
        "title": title,
        "authors": authors,
        "description": description,
        "isbn": isbn,
        "tags": tags,
        "cover_data": cover_data,
        "series": series,
        "series_index": series_index,
    }


def _extract_via_zipfile(epub_path: str) -> dict:
    """Fallback metadata extraction using zipfile + XML.

    Handles EPUBs with missing manifest files that crash ebooklib.
    """
    import xml.etree.ElementTree as ET
    import zipfile

    DC = "http://purl.org/dc/elements/1.1/"
    OPF = "http://www.idpf.org/2007/opf"

    result: dict = {
        "title": "",
        "authors": "",
        "description": "",
        "isbn": "",
        "tags": [],
        "cover_data": None,
        "series": "",
        "series_index": None,
    }

    with zipfile.ZipFile(epub_path, "r") as zf:
        # Find OPF file via container.xml
        opf_path = None
        try:
            container = ET.fromstring(
                zf.read("META-INF/container.xml")
            )
            ns = {
                "c": "urn:oasis:names:tc:opendocument"
                ":xmlns:container",
            }
            rootfile = container.find(
                ".//c:rootfile", ns
            )
            if rootfile is not None:
                opf_path = rootfile.get("full-path")
        except (KeyError, ET.ParseError):
            pass

        if not opf_path:
            return result

        try:
            opf_xml = zf.read(opf_path)
        except KeyError:
            return result

        root = ET.fromstring(opf_xml)
        opf_dir = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""

        # Dublin Core metadata
        title_el = root.find(f".//{{{DC}}}title")
        if title_el is not None and title_el.text:
            result["title"] = title_el.text

        creators = root.findall(f".//{{{DC}}}creator")
        if creators:
            result["authors"] = ", ".join(
                c.text for c in creators if c.text
            )

        desc_el = root.find(f".//{{{DC}}}description")
        if desc_el is not None and desc_el.text:
            result["description"] = desc_el.text

        # ISBN from identifiers
        for ident in root.findall(
            f".//{{{DC}}}identifier"
        ):
            if ident.text is None:
                continue
            scheme = ident.get(f"{{{OPF}}}scheme", "")
            val = ident.text
            if scheme.upper() == "ISBN" or (
                val.replace("-", "").isdigit()
                and len(val) >= 10
            ):
                result["isbn"] = val
                break

        # Tags from subjects
        subjects = root.findall(f".//{{{DC}}}subject")
        result["tags"] = [
            s.text for s in subjects if s.text
        ]

        # Cover image
        cover_href = _find_cover_href(root, OPF)
        if cover_href:
            cover_path = opf_dir + cover_href
            try:
                result["cover_data"] = zf.read(cover_path)
            except KeyError:
                pass

        # Series from calibre:series meta tags
        for meta in root.findall(
            f".//{{{OPF}}}meta"
        ) + root.findall(".//meta"):
            name = meta.get("name", "")
            content = meta.get("content", "")
            if name == "calibre:series" and content:
                result["series"] = content
            elif (
                name == "calibre:series_index"
                and content
            ):
                try:
                    result["series_index"] = float(content)
                except (ValueError, TypeError):
                    pass

        # EPUB3: belongs-to-collection
        if not result["series"]:
            OPF3 = "http://www.idpf.org/2007/opf"
            for meta in root.findall(
                f".//{{{OPF3}}}meta"
            ) + root.findall(".//meta"):
                prop = meta.get("property", "")
                if (
                    prop == "belongs-to-collection"
                    and meta.text
                ):
                    result["series"] = meta.text
                elif (
                    prop == "group-position"
                    and meta.text
                    and result["series_index"] is None
                ):
                    try:
                        result["series_index"] = float(
                            meta.text
                        )
                    except (ValueError, TypeError):
                        pass

    return result


def _find_cover_href(
    root: "ET.Element", opf_ns: str
) -> str | None:
    """Find cover image href from OPF manifest."""
    import xml.etree.ElementTree as ET

    # Method 1: meta name="cover" -> manifest item
    for meta in root.findall(
        f".//{{{opf_ns}}}meta"
    ) + root.findall(".//meta"):
        if meta.get("name") == "cover":
            cover_id = meta.get("content", "")
            for item in root.findall(
                f".//{{{opf_ns}}}item"
            ) + root.findall(".//item"):
                if item.get("id") == cover_id:
                    return item.get("href")

    # Method 2: manifest item with properties="cover-image"
    for item in root.findall(
        f".//{{{opf_ns}}}item"
    ) + root.findall(".//item"):
        props = item.get("properties", "")
        if "cover-image" in props:
            return item.get("href")

    # Method 3: manifest item with "cover" in id/href
    for item in root.findall(
        f".//{{{opf_ns}}}item"
    ) + root.findall(".//item"):
        media = item.get("media-type", "")
        if not media.startswith("image/"):
            continue
        item_id = (item.get("id") or "").lower()
        href = (item.get("href") or "").lower()
        if "cover" in item_id or "cover" in href:
            return item.get("href")

    return None
