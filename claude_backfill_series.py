"""Backfill all series with Hardcover data.

Processes all series in the library, searching Hardcover for each,
fetching raw book data, storing it, deduplicating, matching against
library books, and writing results to DB. Runs in batches of 10
with a 5-minute sleep between batches.
"""

import asyncio
import sys
import time

# Ensure the books package is importable
sys.path.insert(0, ".")

from books.helpers import db, hardcover  # noqa: E402


def log(msg: str) -> None:
    print(msg, flush=True)


async def backfill_series(user_id: int = 1) -> None:
    """Process all series for the given user."""
    db.init_db()
    series_list = db.get_series_list(user_id)
    total = len(series_list)
    log(f"Found {total} series to process")

    matched = 0
    failed = 0
    batch_size = 10

    for i, s in enumerate(series_list):
        name = s["series"]
        sl_id = s["series_link_id"]
        log(f"[{i + 1}/{total}] Processing: {name} (id={sl_id})")

        try:
            # Check existing link for hash-based skip
            link = db.get_series_link_by_id(sl_id)

            # Search Hardcover for the series
            if link and link.get("hardcover_series_id"):
                hc_id = link["hardcover_series_id"]
                hc_name = link["hardcover_series_name"]
            else:
                results = await hardcover.search_series(name)
                best = hardcover.pick_best_series(name, results)
                if not best:
                    log("  No Hardcover match found")
                    failed += 1
                    continue
                hc_id = best["id"]
                hc_name = best["name"]
                log(f"  Matched: {hc_name} (id={hc_id}, {best['books_count']} books)")

            # Fetch raw book data from Hardcover
            raw_books = await hardcover.fetch_series_books(hc_id)
            if not raw_books:
                log("  No books returned from Hardcover")
                failed += 1
                continue

            # Check hash for change detection
            data_hash = hardcover.compute_data_hash(raw_books)
            if link and link.get("data_hash") == data_hash:
                log("  Data unchanged, re-matching only")
            else:
                log(f"  Fetched {len(raw_books)} raw entries")

            # Store link + raw data
            db.link_series(
                user_id, sl_id, hc_id, hc_name,
                data_hash=data_hash,
            )
            db.store_hc_series_books(sl_id, raw_books)

            # Dedup and match
            deduped = hardcover.dedup_series_books(raw_books)
            library_books = db.get_series_books(user_id, sl_id)
            entries = hardcover.match_books(deduped, library_books)
            linked = sum(
                1 for e in entries if e["status"] == "linked"
            )
            unlinked = sum(
                1 for e in entries if e["status"] == "unlinked"
            )

            db.upsert_series_entries(
                sl_id, entries,
                user_id=user_id, series_name=name,
            )

            log(
                f"  {len(deduped)} positions:"
                f" {linked} linked, {unlinked} unlinked"
            )
            matched += 1

        except Exception as exc:
            log(f"  ERROR: {exc}")
            failed += 1

        # Sleep between batches
        if (i + 1) % batch_size == 0 and (i + 1) < total:
            wait_min = 5
            log(f"\n--- Batch complete. Sleeping {wait_min} minutes ---\n")
            time.sleep(wait_min * 60)

    log(f"\nDone! {matched} matched, {failed} failed out of {total}")


if __name__ == "__main__":
    uid = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    asyncio.run(backfill_series(uid))
