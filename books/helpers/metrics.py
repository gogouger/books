"""Library metrics aggregation for the /metrics page.

One DB pass per metric set; all work happens in Python on the result of
a single SELECT. Returns a JSON-able dict consumed by the metrics page.
"""

import json
import re
from collections import Counter

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
               price
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
    # break out sub-genres by tags (normalised). Each book contributes to
    # every tag it has.
    cat_buckets: dict[str, dict] = {}
    for b in books:
        cat = b.get("manual_category") or "Other"
        bucket = cat_buckets.setdefault(cat, {
            "count": 0, "read": 0, "value": 0.0,
            "subgenres": Counter(),
        })
        bucket["count"] += 1
        if b["reading_status"] == "read":
            bucket["read"] += 1
        if b.get("price") is not None:
            bucket["value"] += float(b["price"])
        for tag in _parse_tags(b.get("tags")):
            bucket["subgenres"][_normalise_tag(tag)] += 1

    categories = []
    for cat in ("Religious", "Fiction", "Other"):
        if cat not in cat_buckets:
            continue
        bucket = cat_buckets[cat]
        sub = [
            {"name": name, "count": cnt}
            for name, cnt in bucket["subgenres"].most_common(20)
        ]
        categories.append({
            "name": cat,
            "count": bucket["count"],
            "read": bucket["read"],
            "value": round(bucket["value"], 2),
            "subgenres": sub,
        })

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
        },
        "tiers": tiers,
        "formats": formats,
        "categories": categories,
        "top_by_value": top_by_value,
    }
