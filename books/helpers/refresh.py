import asyncio
import logging
import time

from . import db
from . import hardcover

log = logging.getLogger(__name__)

REFRESH_MAX_AGE_DAYS = 30
REFRESH_RATE_LIMIT_SECONDS = 60
REFRESH_BATCH_SIZE = 50
REFRESH_CYCLE_SECONDS = 86400


async def refresh_series_for_all_users(
    series_link_id: int,
) -> bool:
    """Refresh a series from Hardcover for all monitoring users.

    Fetches HC data once, checks hash for changes, then runs
    matching/placeholder logic for each subscribed user.
    Returns True if data changed, False if unchanged.
    """
    link = db.get_series_link_by_id(series_link_id)
    if not link:
        log.warning(
            "Auto-refresh: series_link %d not found",
            series_link_id,
        )
        return False

    series_name = link["series_name"]
    hc_series_id = link.get("hardcover_series_id")
    if not hc_series_id:
        log.warning(
            "Auto-refresh: %s (id=%d) has no HC id",
            series_name, series_link_id,
        )
        return False

    log.info(
        "Auto-refresh: fetching HC data for %s (hc=%d)",
        series_name, hc_series_id,
    )
    raw_books = await hardcover.fetch_series_books(
        hc_series_id
    )
    if not raw_books:
        log.warning(
            "Auto-refresh: no HC data for %s (hc=%d)",
            series_name, hc_series_id,
        )
        return False

    log.info(
        "Auto-refresh: %s got %d raw entries from HC",
        series_name, len(raw_books),
    )

    data_hash = hardcover.compute_data_hash(raw_books)
    if data_hash == link.get("data_hash"):
        db.touch_series_last_checked(series_link_id)
        log.info(
            "Auto-refresh: %s unchanged (hash match)",
            series_name,
        )
        return False

    log.info(
        "Auto-refresh: %s data changed, processing",
        series_name,
    )

    # Data changed: store raw, dedup, upsert global entries
    db.store_hc_series_books(series_link_id, raw_books)
    deduped = hardcover.dedup_series_books(raw_books)
    log.info(
        "Auto-refresh: %s deduped to %d entries",
        series_name, len(deduped),
    )

    # Match against first user's library for global entry upsert
    users = db.get_monitoring_users(series_link_id)
    if not users:
        log.info(
            "Auto-refresh: %s has no monitoring users",
            series_name,
        )
        db.touch_series_last_checked(series_link_id)
        return False

    first_user = users[0]
    library_books = db.get_series_books(
        first_user["user_id"], series_link_id
    )
    entries = hardcover.match_books(deduped, library_books)
    db.upsert_series_entries(series_link_id, entries)

    # Per-user: sync positions and create placeholders
    for user in users:
        uid = user["user_id"]
        display = user["display_name"]

        user_library = db.get_series_books(
            uid, series_link_id
        )
        user_entries = hardcover.match_books(
            deduped, user_library
        )

        matched = sum(
            1 for e in user_entries if e.get("book_id")
        )
        unmatched = len(user_entries) - matched
        log.info(
            "Auto-refresh: %s user %d: %d matched, "
            "%d unmatched of %d entries",
            display, uid, matched,
            unmatched, len(user_entries),
        )

        db.sync_book_positions(uid, user_entries)
        db.ensure_user_books_for_series(
            uid, series_link_id, display
        )

    # Fetch slug if missing
    hc_slug = link.get("hardcover_slug")
    if not hc_slug:
        slugs = await hardcover.fetch_series_slugs(
            [hc_series_id]
        )
        hc_slug = slugs.get(hc_series_id)

    # Update link with new hash and timestamp
    db.link_series(
        series_link_id,
        hc_series_id,
        link.get("hardcover_series_name") or "",
        data_hash=data_hash,
        hardcover_slug=hc_slug,
    )

    log.info(
        "Auto-refresh: %s complete (%d users)",
        series_name, len(users),
    )
    return True


async def auto_refresh_loop() -> None:
    """Background loop that refreshes stale series data.

    Waits 60s after startup, then checks daily for series
    not refreshed in REFRESH_MAX_AGE_DAYS. Rate-limited to
    one HC API call per REFRESH_RATE_LIMIT_SECONDS.
    """
    await asyncio.sleep(60)
    log.info("Auto-refresh loop started")

    while True:
        try:
            cycle_start = time.monotonic()
            due = db.get_series_due_for_refresh(
                max_age_days=REFRESH_MAX_AGE_DAYS,
                limit=REFRESH_BATCH_SIZE,
            )
            log.info(
                "Auto-refresh cycle: %d series due",
                len(due),
            )

            changed = 0
            unchanged = 0
            errors = 0
            for i, link in enumerate(due, 1):
                log.info(
                    "Auto-refresh: [%d/%d] starting %s"
                    " (id=%d, last_checked=%s)",
                    i, len(due),
                    link["series_name"], link["id"],
                    link.get("last_checked") or "never",
                )
                try:
                    result = (
                        await refresh_series_for_all_users(
                            link["id"]
                        )
                    )
                    if result:
                        changed += 1
                    else:
                        unchanged += 1
                except Exception:
                    errors += 1
                    log.exception(
                        "Auto-refresh failed for %s"
                        " (id=%d)",
                        link["series_name"], link["id"],
                    )
                await asyncio.sleep(
                    REFRESH_RATE_LIMIT_SECONDS
                )

            elapsed = time.monotonic() - cycle_start
            log.info(
                "Auto-refresh cycle done: %d changed, "
                "%d unchanged, %d errors in %.0fs",
                changed, unchanged, errors, elapsed,
            )

            # Drop orphan series_link rows that no user owns any book
            # in. Cleanup after the refresh in case the user manually
            # unlinked or migrated books to standalone.
            try:
                pruned = db.prune_empty_series_links()
                if pruned:
                    log.info(
                        "Pruned %d empty series_link rows", pruned,
                    )
            except Exception:
                log.exception("Empty-series prune failed")

        except Exception:
            log.exception(
                "Auto-refresh cycle error"
            )

        await asyncio.sleep(REFRESH_CYCLE_SECONDS)
