import logging

import httpx

log = logging.getLogger(__name__)

GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes"
OPEN_LIBRARY_SEARCH = "https://openlibrary.org/search.json"


async def search_google_books(
    query: str, max_results: int = 5
) -> list[dict]:
    params = {"q": query, "maxResults": max_results}
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(
                GOOGLE_BOOKS_URL, params=params
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            log.exception("Google Books search failed")
            return []

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
    params = {"q": query, "limit": max_results}
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(
                OPEN_LIBRARY_SEARCH, params=params
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            log.exception("Open Library search failed")
            return []

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

    return {
        "title": title,
        "authors": authors,
        "description": description,
        "isbn": isbn,
        "tags": tags,
        "cover_data": cover_data,
    }
