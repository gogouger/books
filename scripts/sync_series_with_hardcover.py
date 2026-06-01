"""Two-stage sync from Hardcover so ghost entries actually appear.

Stage 1 — link: for each `series_link` row with NULL `hardcover_series_id`,
search Hardcover by name, pick the best match, and write the IDs back.

Stage 2 — refresh: for each linked series, fetch the canonical book list
from Hardcover, dedup, match against the user's library, and upsert into
`series_entries`. Once this runs, the ghost code paths shipped earlier
will start surfacing unowned books in the series detail + library views.

Run inside the books-api container after `HARDCOVER_API_TOKEN` is in env:
    docker exec ggouger-books-api-1 sh -c \\
      "cd /app && uv run python scripts/sync_series_with_hardcover.py --user gordon"

Useful flags:
  --dry-run                 don't write anything; preview the matches
  --stage link              only resolve hardcover_series_id (skip refresh)
  --stage refresh           only refresh already-linked series
  --stage both              both (default)
  --only "Some Series Name" filter to one series (substring match)

Polite delays (0.5s) between API calls so we don't hammer Hardcover.
"""

from __future__ import annotations

import argparse
import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone

from books.helpers import hardcover
from books.helpers import db as books_db


async def link_stage(
    conn: sqlite3.Connection,
    dry_run: bool,
    only_filter: str | None,
) -> None:
    sql = (
        "SELECT id, series_name FROM series_link "
        "WHERE hardcover_series_id IS NULL"
    )
    params: tuple = ()
    if only_filter:
        sql += " AND series_name LIKE ?"
        params = (f"%{only_filter}%",)
    sql += " ORDER BY series_name"
    rows = conn.execute(sql, params).fetchall()

    print(f"\n[link] {len(rows)} series need linking")
    linked = 0
    for r in rows:
        sid, name = r["id"], r["series_name"]
        print(f"  {name!r} ...", end=" ", flush=True)
        try:
            results = await hardcover.search_series(name)
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR: {exc}")
            continue
        if not results:
            print("no results")
            continue
        best = hardcover.pick_best_series(name, results)
        if not best:
            print("no best match")
            continue
        print(
            f"-> #{best['id']} {best['name']!r} "
            f"({best['books_count']} books)"
        )
        if not dry_run:
            conn.execute(
                "UPDATE series_link SET "
                "hardcover_series_id = ?, "
                "hardcover_slug = ?, "
                "hardcover_series_name = ? "
                "WHERE id = ?",
                (best["id"], best["slug"], best["name"], sid),
            )
            conn.commit()
            linked += 1
        await asyncio.sleep(0.5)
    print(f"[link] {'would link' if dry_run else 'linked'} {linked}")


async def refresh_stage(
    conn: sqlite3.Connection,
    user_id: int,
    dry_run: bool,
    only_filter: str | None,
    max_age_days: float,
    force: bool,
) -> None:
    sql = (
        "SELECT id, series_name, hardcover_series_id, last_checked "
        "FROM series_link "
        "WHERE hardcover_series_id IS NOT NULL"
    )
    params: tuple = ()
    if only_filter:
        sql += " AND series_name LIKE ?"
        params = (f"%{only_filter}%",)
    sql += " ORDER BY series_name"
    rows = conn.execute(sql, params).fetchall()

    # Cache-skip: don't re-fetch series whose last_checked is fresh.
    # The Hardcover schema barely changes day-to-day; default 7d cache is
    # more than generous. --force overrides.
    if not force and max_age_days > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
        fresh = []
        stale = []
        for r in rows:
            lc = r["last_checked"]
            if not lc:
                stale.append(r)
                continue
            try:
                checked = datetime.fromisoformat(lc)
            except ValueError:
                stale.append(r)
                continue
            if checked >= cutoff:
                fresh.append(r)
            else:
                stale.append(r)
        if fresh:
            print(
                f"[refresh] skipping {len(fresh)} fresh series "
                f"(checked within {max_age_days}d) — pass --force to override"
            )
        rows = stale

    print(f"\n[refresh] {len(rows)} linked series to refresh")
    refreshed = 0
    total_entries = 0
    for r in rows:
        sid = r["id"]
        name = r["series_name"]
        hc_id = r["hardcover_series_id"]
        print(f"  {name!r} (HC #{hc_id}) ...", end=" ", flush=True)
        try:
            raw_books = await hardcover.fetch_series_books(hc_id)
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR: {exc}")
            continue
        if not raw_books:
            print("empty")
            continue
        deduped = hardcover.dedup_series_books(raw_books)
        library_rows = conn.execute(
            "SELECT id, title, authors FROM books "
            "WHERE user_id = ? AND series_link_id = ?",
            (user_id, sid),
        ).fetchall()
        library_books = [
            {"id": b["id"], "title": b["title"], "authors": b["authors"]}
            for b in library_rows
        ]
        entries = hardcover.match_books(deduped, library_books)
        total_entries += len(entries)
        if not dry_run:
            books_db.upsert_series_entries(sid, entries)
            data_hash = hardcover.compute_data_hash(raw_books)
            conn.execute(
                "UPDATE series_link SET "
                "data_hash = ?, last_checked = ? "
                "WHERE id = ?",
                (
                    data_hash,
                    datetime.now(timezone.utc).isoformat(),
                    sid,
                ),
            )
            conn.commit()
            refreshed += 1
        print(
            f"-> {len(entries)} entries "
            f"({len(library_books)} matched in library)"
        )
        await asyncio.sleep(0.5)
    print(
        f"[refresh] {'would refresh' if dry_run else 'refreshed'} "
        f"{refreshed} series, {total_entries} entries total"
    )


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="gordon")
    ap.add_argument("--db", default="/app/data/books.db")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--stage",
        choices=("link", "refresh", "both"),
        default="both",
    )
    ap.add_argument(
        "--only",
        default=None,
        help="filter series by substring (e.g. --only 'Stormlight')",
    )
    ap.add_argument(
        "--max-age",
        type=float,
        default=7.0,
        help=(
            "skip refresh for series whose last_checked is within this many "
            "days (default 7). Avoids hammering the API with repeated syncs."
        ),
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="ignore --max-age and refresh everything",
    )
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    user = conn.execute(
        "SELECT id FROM users WHERE username = ?", (args.user,)
    ).fetchone()
    if not user:
        raise SystemExit(f"user {args.user!r} not found")
    user_id = user["id"]

    if args.stage in ("link", "both"):
        await link_stage(conn, args.dry_run, args.only)
    if args.stage in ("refresh", "both"):
        await refresh_stage(
            conn, user_id, args.dry_run, args.only,
            args.max_age, args.force,
        )
    conn.close()


if __name__ == "__main__":
    asyncio.run(main())
