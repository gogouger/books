"""Library metrics aggregation for the /metrics page.

One DB pass per metric set; all work happens in Python on the result of
a single SELECT. Returns a JSON-able dict consumed by the metrics page.
"""

import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone

from . import db


# Coarse sub-genre normalisation. Hardcover tags are inconsistent
# (mixed-case, plural / singular, etc) — collapse the common ones so the
# breakdown isn't 200 buckets of one book each.
_TAG_ALIAS = {
    "scifi": "Science Fiction",
    "sci-fi": "Science Fiction",
    "sf": "Science Fiction",
    "science-fiction": "Science Fiction",
    "fantasy": "Fantasy",
    "epic-fantasy": "Epic Fantasy",
    "high-fantasy": "High Fantasy",
    "urban-fantasy": "Urban Fantasy",
    "litrpg": "LitRPG",
    "horror": "Horror",
    "thriller": "Thriller",
    "mystery": "Mystery",
    "romance": "Romance",
    "historical-fiction": "Historical Fiction",
    "commentary": "Commentary",
    "biblical-theology": "Biblical Theology",
    "systematic-theology": "Systematic Theology",
    "theology": "Theology",
    "doctrine": "Doctrine",
    "biography": "Biography",
    "memoir": "Memoir",
    "missions": "Missions",
    "apologetics": "Apologetics",
    "spirituality": "Spirituality",
    "preaching": "Preaching",
    "marriage": "Marriage",
    "parenting": "Parenting",
}


def _parse_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        # Some legacy rows stored a JSON-encoded JSON string.
        if isinstance(parsed, str):
            parsed = json.loads(parsed)
    except (json.JSONDecodeError, TypeError):
        # Comma-separated fallback for the oldest rows.
        return [t.strip() for t in raw.split(",") if t.strip()]
    if not isinstance(parsed, list):
        return []
    return [str(t).strip() for t in parsed if str(t).strip()]


def _normalise_tag(tag: str) -> str:
    key = re.sub(r"\s+", "-", tag.lower().strip())
    return _TAG_ALIAS.get(key, tag.strip().title())


def compute_metrics(user_id: int) -> dict:
    """Aggregate library counts + value + breakdowns for one user."""
    conn = db.get_db()
    rows = conn.execute(
        """
        SELECT id, title, authors, manual_category, tags,
               book_format, also_physical,
               is_owned, reading_status, rating, is_favorite,
               is_all_time_fav, is_second_fav, is_third_fav,
               price, pages, audio_seconds,
               date_finished, date_added, published_date
        FROM books
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchall()
    conn.close()
    books = [dict(r) for r in rows]

    # --- Headline counts -------------------------------------------------
    total = len(books)
    owned = sum(1 for b in books if b["is_owned"] == 1)
    read = sum(1 for b in books if b["reading_status"] == "read")
    reading = sum(1 for b in books if b["reading_status"] == "reading")
    unread = sum(1 for b in books if b["reading_status"] == "unread")

    # --- Value -----------------------------------------------------------
    priced = [b for b in books if b.get("price") is not None]
    priced_count = len(priced)
    total_value = round(sum(float(b["price"]) for b in priced), 2)
    owned_priced = [
        b for b in priced if b["is_owned"] == 1
    ]
    owned_value = round(sum(float(b["price"]) for b in owned_priced), 2)
    avg_price = (
        round(total_value / priced_count, 2) if priced_count else 0
    )

    # --- Tier counts -----------------------------------------------------
    tiers = {
        "gold": sum(1 for b in books if b["is_all_time_fav"] == 1),
        "silver": sum(1 for b in books if b["is_second_fav"] == 1),
        "bronze": sum(1 for b in books if b["is_third_fav"] == 1),
        "five_star": sum(1 for b in books if b["rating"] == 5),
        "hearted": sum(1 for b in books if b["is_favorite"] == 1),
    }

    # --- Format split ----------------------------------------------------
    fmt_counter: Counter[str] = Counter()
    fmt_value: dict[str, float] = {}
    for b in books:
        fmt = b.get("book_format") or "ebook"
        fmt_counter[fmt] += 1
        if b.get("price") is not None:
            fmt_value[fmt] = round(
                fmt_value.get(fmt, 0) + float(b["price"]), 2,
            )
        # also_physical = dual format ownership. Count as +1 physical
        # for the count column but not for value (we don't track two
        # prices).
        if b.get("also_physical") == 1 and fmt != "physical":
            fmt_counter["physical"] += 1

    formats = [
        {
            "format": f,
            "count": fmt_counter[f],
            "value": round(fmt_value.get(f, 0), 2),
        }
        for f in sorted(fmt_counter, key=lambda x: -fmt_counter[x])
    ]

    # --- Category + sub-genre breakdown ----------------------------------
    # manual_category buckets: Religious / Fiction / Other. Within each,
    # break out sub-genres by tags (normalised). Track per-subgenre read
    # counts so the page can show 'Epic Fantasy 18 (12 read · 67%)'.
    cat_buckets: dict[str, dict] = {}
    for b in books:
        cat = b.get("manual_category") or "Other"
        bucket = cat_buckets.setdefault(cat, {
            "count": 0, "read": 0, "value": 0.0,
            "sub_count": Counter(),
            "sub_read": Counter(),
            "sub_books": {},
        })
        bucket["count"] += 1
        is_read = b["reading_status"] == "read"
        if is_read:
            bucket["read"] += 1
        if b.get("price") is not None:
            bucket["value"] += float(b["price"])
        for tag in _parse_tags(b.get("tags")):
            norm = _normalise_tag(tag)
            bucket["sub_count"][norm] += 1
            if is_read:
                bucket["sub_read"][norm] += 1
            bucket["sub_books"].setdefault(norm, []).append({
                "id": b["id"],
                "title": b["title"],
                "is_read": is_read,
            })

    categories = []
    # 'Other' is no longer a category we produce; every book lives in
    # Religious or Fiction. The loop still tolerates legacy rows just in
    # case but we don't surface an Other section.
    for cat in ("Religious", "Fiction"):
        if cat not in cat_buckets:
            continue
        bucket = cat_buckets[cat]
        sub = [
            {
                "name": name,
                "count": cnt,
                "read": bucket["sub_read"][name],
                "books": sorted(
                    bucket["sub_books"][name],
                    key=lambda x: (not x["is_read"], x["title"]),
                )[:60],
            }
            for name, cnt in bucket["sub_count"].most_common(20)
        ]
        categories.append({
            "name": cat,
            "count": bucket["count"],
            "read": bucket["read"],
            "value": round(bucket["value"], 2),
            "subgenres": sub,
        })

    # --- Read vs listened ------------------------------------------------
    # 'Listened' = read + audiobook. 'Read' = read + non-audiobook (physical
    # or ebook). Books with also_physical=1 don't double-count here — we
    # treat their primary format as the surface for this stat.
    read_books = 0
    read_value = 0.0
    listened_books = 0
    listened_value = 0.0
    for b in books:
        if b["reading_status"] != "read":
            continue
        fmt = b.get("book_format") or "ebook"
        if fmt == "audiobook":
            listened_books += 1
            if b.get("price") is not None:
                listened_value += float(b["price"])
        else:
            read_books += 1
            if b.get("price") is not None:
                read_value += float(b["price"])

    total_finished = read_books + listened_books
    pct_listened = round(
        100 * listened_books / total_finished, 1,
    ) if total_finished else 0

    read_vs_listened = {
        "read": {
            "count": read_books,
            "value": round(read_value, 2),
        },
        "listened": {
            "count": listened_books,
            "value": round(listened_value, 2),
        },
        "percent_listened": pct_listened,
    }

    # --- Top 10 by price -------------------------------------------------
    top_by_value = sorted(
        priced, key=lambda b: -float(b["price"]),
    )[:10]
    top_by_value = [
        {
            "id": b["id"],
            "title": b["title"],
            "authors": b["authors"],
            "price": round(float(b["price"]), 2),
            "format": b.get("book_format"),
        }
        for b in top_by_value
    ]

    # --- Untagged count --------------------------------------------------
    untagged_count = sum(
        1 for b in books
        if not _parse_tags(b.get("tags"))
    )

    # --- Lifetime + this-year totals + by-year breakdown ----------------
    # Pages/audio totals only count READ books with the data field set —
    # we don't extrapolate from estimates so the headline numbers stay
    # honest. UI can show "x of y read books have a page count".
    now = datetime.now(timezone.utc)
    this_year = now.year

    lifetime = {
        "books_finished": 0,
        "pages_read": 0,
        "audio_seconds": 0,
        "spend": 0.0,
        "books_with_pages": 0,
        "books_with_audio": 0,
    }
    yearly_buckets: dict[int, dict] = defaultdict(lambda: {
        "year": 0, "finished": 0, "pages": 0, "audio_seconds": 0, "spend": 0.0,
    })

    for b in books:
        if b["reading_status"] == "read":
            year = _year_of(b.get("date_finished"))
            lifetime["books_finished"] += 1
            if b.get("pages"):
                lifetime["pages_read"] += int(b["pages"])
                lifetime["books_with_pages"] += 1
            if b.get("audio_seconds"):
                lifetime["audio_seconds"] += int(b["audio_seconds"])
                lifetime["books_with_audio"] += 1
            if year is not None:
                bucket = yearly_buckets[year]
                bucket["year"] = year
                bucket["finished"] += 1
                if b.get("pages"):
                    bucket["pages"] += int(b["pages"])
                if b.get("audio_seconds"):
                    bucket["audio_seconds"] += int(b["audio_seconds"])

        # Spend totals: bucket by date_added year (when you bought it),
        # not date_finished (when you read it). 'Lifetime spend' equals
        # the existing value.total above.
        if b.get("price") is not None:
            add_year = _year_of(b.get("date_added"))
            if add_year is not None:
                yearly_buckets[add_year]["year"] = add_year
                yearly_buckets[add_year]["spend"] += float(b["price"])

    lifetime["spend"] = total_value
    lifetime_hours = round(lifetime["audio_seconds"] / 3600.0, 1)

    by_year = sorted(yearly_buckets.values(), key=lambda x: x["year"])
    for y in by_year:
        y["spend"] = round(y["spend"], 2)
        y["hours"] = round(y["audio_seconds"] / 3600.0, 1)

    # This-year tile values
    ty = yearly_buckets.get(this_year, {
        "finished": 0, "pages": 0, "audio_seconds": 0, "spend": 0.0,
    })
    this_year_block = {
        "year": this_year,
        "finished": ty["finished"],
        "pages": ty["pages"],
        "hours": round(ty["audio_seconds"] / 3600.0, 1),
        "spend": round(ty["spend"], 2),
        "day_of_year": now.timetuple().tm_yday,
        "days_in_year": 366 if _is_leap(this_year) else 365,
    }

    # --- Records ---------------------------------------------------------
    def _book_dict(b: dict) -> dict:
        return {
            "id": b["id"],
            "title": b["title"],
            "authors": b["authors"],
            "format": b.get("book_format"),
        }

    longest_pages = max(
        (b for b in books if b.get("pages")),
        key=lambda b: int(b["pages"]),
        default=None,
    )
    longest_audio = max(
        (b for b in books if b.get("audio_seconds")),
        key=lambda b: int(b["audio_seconds"]),
        default=None,
    )
    most_expensive = max(
        (b for b in books if b.get("price")),
        key=lambda b: float(b["price"]),
        default=None,
    )
    oldest_book = min(
        (b for b in books if (b.get("published_date") or "")[:4].isdigit()),
        key=lambda b: int(b["published_date"][:4]),
        default=None,
    )
    records = {
        "longest_pages": (
            {**_book_dict(longest_pages), "pages": int(longest_pages["pages"])}
            if longest_pages else None
        ),
        "longest_audio": (
            {
                **_book_dict(longest_audio),
                "audio_seconds": int(longest_audio["audio_seconds"]),
                "hours": round(int(longest_audio["audio_seconds"]) / 3600.0, 1),
            }
            if longest_audio else None
        ),
        "most_expensive": (
            {**_book_dict(most_expensive), "price": round(float(most_expensive["price"]), 2)}
            if most_expensive else None
        ),
        "oldest_book": (
            {**_book_dict(oldest_book), "published_year": int(oldest_book["published_date"][:4])}
            if oldest_book else None
        ),
    }

    # --- Author stats ----------------------------------------------------
    # First-author only — joint authors get attributed to whoever leads
    # the byline.
    author_counts = Counter()
    author_read = Counter()
    author_spend = defaultdict(float)
    for b in books:
        first = (b["authors"] or "").split(",", 1)[0].strip()
        if not first or first.lower() == "unknown":
            continue
        author_counts[first] += 1
        if b["reading_status"] == "read":
            author_read[first] += 1
        if b.get("price") is not None:
            author_spend[first] += float(b["price"])

    top_authors_collected = [
        {"name": n, "count": c} for n, c in author_counts.most_common(8)
    ]
    top_authors_read = [
        {"name": n, "count": c} for n, c in author_read.most_common(8)
    ]
    top_authors_spend = [
        {"name": n, "value": round(v, 2)}
        for n, v in sorted(author_spend.items(), key=lambda x: -x[1])[:8]
    ]

    # --- Rating distribution --------------------------------------------
    rating_hist = {str(i): 0 for i in range(1, 6)}
    for b in books:
        if b.get("rating"):
            rating_hist[str(int(b["rating"]))] += 1

    return {
        "counts": {
            "total": total,
            "owned": owned,
            "read": read,
            "reading": reading,
            "unread": unread,
            "percent_read": round(100 * read / total, 1) if total else 0,
        },
        "value": {
            "total": total_value,
            "owned": owned_value,
            "avg": avg_price,
            "priced_count": priced_count,
            "unpriced_count": total - priced_count,
            "untagged_count": untagged_count,
        },
        "tiers": tiers,
        "formats": formats,
        "read_vs_listened": read_vs_listened,
        "categories": categories,
        "top_by_value": top_by_value,
        "lifetime": {
            "books_finished": lifetime["books_finished"],
            "pages_read": lifetime["pages_read"],
            "audio_seconds": lifetime["audio_seconds"],
            "hours_listened": lifetime_hours,
            "spend": round(lifetime["spend"], 2),
            "books_with_pages": lifetime["books_with_pages"],
            "books_with_audio": lifetime["books_with_audio"],
        },
        "this_year": this_year_block,
        "by_year": by_year,
        "records": records,
        "authors": {
            "top_collected": top_authors_collected,
            "top_read": top_authors_read,
            "top_spend": top_authors_spend,
        },
        "rating_hist": rating_hist,
    }


def _year_of(date_str: str | None) -> int | None:
    if not date_str:
        return None
    try:
        return int(str(date_str)[:4])
    except (ValueError, TypeError):
        return None


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
