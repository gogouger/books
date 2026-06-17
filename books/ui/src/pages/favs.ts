import { api } from '../api';
import { getLibraryUsername } from '../context';
import { bookCardHtml } from '../components/book-card';
import { attachGridClickHandlers } from '../components/book-grid';
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
        // Two queries, merged. The API doesn't OR these natively.
        const [favRes, fiveStarRes] = await Promise.all([
            api.getBooks(username, { is_favorite: true, limit: 1000, sort: 'title', order: 'asc' }),
            api.getBooks(username, { min_rating: 5, max_rating: 5, limit: 1000, sort: 'title', order: 'asc' }),
        ]);

        const seen = new Set<number>();
        const all: any[] = [];
        for (const b of [...favRes.books, ...fiveStarRes.books]) {
            if (seen.has(b.id)) continue;
            seen.add(b.id);
            all.push(b);
        }

        const heading = `
            <div class="d-flex align-items-baseline justify-content-between flex-wrap mb-3">
                <h2 class="mb-0">My Favs</h2>
                <a href="#/library" class="text-muted small">
                    Browse the full library <i class="bi bi-arrow-right"></i>
                </a>
            </div>
        `;

        if (!all.length) {
            app.innerHTML = heading + emptyState();
            return;
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

        let html = heading;
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
