"""Spike script: test Hardcover series matching against library.

Read-only against both library DB and Hardcover API.
Picks the 10 series with the most books and checks data quality.

Run with: uv run python claude_spike_series.py
"""

import asyncio
import sys

from books.helpers import db, hardcover


async def main() -> None:
    db.init_db()

    # Get all series for user_id=1, pick top 10 by book count
    series_list = db.get_series_list(user_id=1)
    series_list.sort(key=lambda s: s["total_books"], reverse=True)
    top_series = series_list[:10]

    if not top_series:
        print("No series found in library.")
        return

    print(f"Testing {len(top_series)} series against Hardcover\n")
    print("=" * 60)

    total_expected = 0
    total_owned = 0
    total_missing = 0
    no_match_series = []

    for s in top_series:
        name = s["series"]
        lib_count = s["total_books"]
        print(f"\n{'=' * 60}")
        print(f"SERIES: {name} ({lib_count} books in library)")
        print("-" * 60)

        # Search Hardcover for this series
        results = await hardcover.search_series(name)
        if not results:
            print("  ** No Hardcover match found **")
            no_match_series.append(name)
            continue

        # Take the first result
        hc_match = results[0]
        print(
            f"  HC match: {hc_match['name']} "
            f"(id={hc_match['id']}, "
            f"{hc_match['books_count']} books)"
        )

        # Fetch full book list
        hc_books = await hardcover.get_series_books(hc_match["id"])
        if not hc_books:
            print("  ** No books returned from Hardcover **")
            no_match_series.append(name)
            continue

        print(f"  HC books: {len(hc_books)} entries")

        # Get library books for this series
        lib_books = db.get_series_books(user_id=1, series_name=name)

        # Match
        matched = hardcover.match_books(hc_books, lib_books)
        owned = [b for b in matched if b["status"] == "owned"]
        missing = [b for b in matched if b["status"] == "missing"]

        total_expected += len(matched)
        total_owned += len(owned)
        total_missing += len(missing)

        print(
            f"  Result: {len(owned)} owned, "
            f"{len(missing)} missing "
            f"(of {len(matched)} expected)"
        )

        if owned:
            print("\n  OWNED:")
            for b in owned:
                pos = b["position"]
                pos_str = (
                    str(int(pos)) if pos == int(pos) else str(pos)
                )
                print(f"    #{pos_str}: {b['title']}")

        if missing:
            print("\n  MISSING:")
            for b in missing:
                pos = b["position"]
                pos_str = (
                    str(int(pos)) if pos == int(pos) else str(pos)
                )
                print(
                    f"    #{pos_str}: {b['title']} "
                    f"({b['author']})"
                )

        # Show library books that didn't match any HC entry
        matched_ids = {
            b["book_id"] for b in matched if b["book_id"]
        }
        unmatched_lib = [
            lb for lb in lib_books if lb["id"] not in matched_ids
        ]
        if unmatched_lib:
            print(f"\n  UNMATCHED LIBRARY ({len(unmatched_lib)}):")
            for lb in unmatched_lib:
                idx = lb.get("series_index")
                idx_str = ""
                if idx is not None:
                    idx_str = (
                        f"#{int(idx)}: "
                        if idx == int(idx)
                        else f"#{idx}: "
                    )
                print(f"    {idx_str}{lb['title']}")

    # Summary
    print(f"\n{'=' * 60}")
    print("SUMMARY")
    print("=" * 60)
    print(f"Series tested: {len(top_series)}")
    print(f"No HC match: {len(no_match_series)}")
    if no_match_series:
        for name in no_match_series:
            print(f"  - {name}")
    print(f"Total expected books: {total_expected}")
    print(f"Total owned: {total_owned}")
    print(f"Total missing: {total_missing}")
    if total_expected > 0:
        pct = total_owned / total_expected * 100
        print(f"Overall match rate: {pct:.0f}%")


if __name__ == "__main__":
    if not hardcover.HARDCOVER_API_TOKEN:
        print(
            "ERROR: HARDCOVER_API_TOKEN not set in .env",
            file=sys.stderr,
        )
        sys.exit(1)
    asyncio.run(main())
