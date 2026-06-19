import { api } from '../api';
import { getLibraryUsername } from '../context';
import { bookCardHtml } from '../components/book-card';
import { attachGridClickHandlers } from '../components/book-grid';
import { renderSeriesCard, attachSeriesGridHandlers } from './series-list';
import { setAuthorFilter } from './library';
import { navigateHome } from '../router';

// "My Favs" landing. Shows the union of (is_favorite=1) and (rating=5),
// grouped by manual_category (Religious / Fiction / Other). Within each
// category, all-time favorites (is_all_time_fav=1) sort first, then 5/5
// rated, then the rest of the hearted books. The gem badge on the cover
// marks all-time favs visually.
const CATEGORY_ORDER = ['Religious', 'Fiction', 'Other'];

export async function renderFavs(): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;

    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;

    try {
        // Three queries, merged: hearted books, 5-star books, and the
        // full series list (so we can filter for hearted/tiered series).
        const [favRes, fiveStarRes, seriesRes] = await Promise.all([
            api.getBooks(username, { is_favorite: true, limit: 1000, sort: 'title', order: 'asc' }),
            api.getBooks(username, { min_rating: 5, max_rating: 5, limit: 1000, sort: 'title', order: 'asc' }),
            api.getSeries(username, true),
        ]);

        const seen = new Set<number>();
        const all: any[] = [];
        for (const b of [...favRes.books, ...fiveStarRes.books]) {
            if (seen.has(b.id)) continue;
            seen.add(b.id);
            all.push(b);
        }

        // Series the user has hearted or tiered (gold/silver) get their
        // own row at the top of /favs. Sort: gold → silver → hearted →
        // title (matches the in-bucket book ordering below).
        const allSeries: any[] = seriesRes?.series || [];
        const favSeries = allSeries.filter((s: any) =>
            s.is_all_time_fav === 1
            || s.is_second_fav === 1
            || s.is_favorite === 1,
        );
        const seriesTier = (s: any) =>
            s.is_all_time_fav === 1 ? 0
            : s.is_second_fav === 1 ? 1
            : 2;
        favSeries.sort((a: any, b: any) => {
            const t = seriesTier(a) - seriesTier(b);
            if (t !== 0) return t;
            return (a.series || '').localeCompare(b.series || '');
        });

        const heading = `
            <div class="d-flex align-items-baseline justify-content-between flex-wrap mb-3">
                <h2 class="mb-0">My Favs</h2>
                <a href="#/library" class="text-muted small">
                    Browse the full library <i class="bi bi-arrow-right"></i>
                </a>
            </div>
        `;

        if (!all.length && !favSeries.length) {
            app.innerHTML = heading + emptyState();
            return;
        }

        // Build the favorite-series row (rendered above the book buckets).
        let seriesRow = '';
        if (favSeries.length) {
            seriesRow += `<h3 class="favs-category-heading">Favorite Series<span class="text-muted small ms-2">${favSeries.length}</span></h3>`;
            seriesRow += '<div class="book-grid mb-4">';
            for (const s of favSeries) seriesRow += renderSeriesCard(s);
            seriesRow += '</div>';
        }

        // Sort within each bucket: all-time favs first, then 5-star, then
        // hearted-only. Tiebreak by title.
        const tier = (b: any) =>
            b.is_all_time_fav === 1 ? 0
            : b.rating === 5 ? 1
            : 2;
        const sortFn = (a: any, b: any) => {
            const t = tier(a) - tier(b);
            if (t !== 0) return t;
            return (a.sort_title || a.title).localeCompare(b.sort_title || b.title);
        };

        const buckets: Record<string, any[]> = { Religious: [], Fiction: [], Other: [] };
        for (const b of all) {
            const cat = b.manual_category && buckets[b.manual_category]
                ? b.manual_category
                : 'Other';
            buckets[cat].push(b);
        }
        for (const cat of CATEGORY_ORDER) buckets[cat].sort(sortFn);

        let html = heading + seriesRow;
        for (const cat of CATEGORY_ORDER) {
            const items = buckets[cat];
            if (!items.length) continue;
            const allTime = items.filter(b => b.is_all_time_fav === 1).length;
            const fiveStar = items.filter(b => b.rating === 5).length;
            const meta = allTime > 0
                ? `<span class="text-muted small ms-2">${allTime} all-time · ${fiveStar} five-star · ${items.length} total</span>`
                : `<span class="text-muted small ms-2">${items.length}</span>`;
            html += `<h3 class="favs-category-heading">${cat}${meta}</h3>`;
            html += '<div class="book-grid">';
            for (const b of items) html += bookCardHtml(b);
            html += '</div>';
        }

        app.innerHTML = html;
        attachGridClickHandlers(app, (author) => {
            setAuthorFilter(author);
            navigateHome();
        });
        // Wire series-card + author-link clicks for the series row.
        if (favSeries.length) attachSeriesGridHandlers(app);
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load favorites: ${err.message}
            </div>
        `;
    }
}

function emptyState(): string {
    return `
        <div class="text-center text-muted py-5">
            <i class="bi bi-gem" style="font-size: 3rem;"></i>
            <p class="mt-2 mb-1">No favorites yet.</p>
            <p class="small">
                Heart a book or rate one 5/5 from the
                <a href="#/library">library</a> to add it here.
            </p>
        </div>
    `;
}
