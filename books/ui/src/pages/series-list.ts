import { api } from '../api';
import { getLibraryUsername } from '../context';
import { navigate, navigateHome } from '../router';
import { setAuthorFilter } from './library';
import {
    filterBarHtml,
    attachFilterHandlers,
    FilterState,
    FilterOption,
    SortOption,
} from '../components/filter-bar';

let cachedSeries: any[] | null = null;
let cachedStandalones: any[] | null = null;
let savedScrollY = 0;
let scrollListener: (() => void) | null = null;
let showHidden = false;
let showOngoing = false;

let currentState: FilterState = {
    q: '',
    filter: '',
    sort: 'title',
    order: 'asc',
    rated: null,  // unused in series view but required by FilterState
};

const SERIES_FILTER_OPTIONS: FilterOption[] = [
    { value: '', label: 'All series' },
    { value: '_hr1', label: '', hr: true },
    { value: 'complete', label: 'Complete' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'unread', label: 'Unread' },
    { value: '_hr2', label: '', hr: true },
    { value: 'ongoing', label: 'Ongoing (author writing)' },
];

const SERIES_SORT_OPTIONS: SortOption[] = [
    { value: 'title', label: 'Title' },
    { value: 'author', label: 'Author' },
    { value: 'rating', label: 'Rating' },
    { value: 'books', label: 'Books' },
];

export function invalidateSeriesCache(): void {
    cachedSeries = null;
    cachedStandalones = null;
}

export function resetSeriesFilters(): void {
    currentState = { q: '', filter: '', sort: 'title', order: 'asc', rated: null };
    cachedSeries = null;
    cachedStandalones = null;
    savedScrollY = 0;
}

export async function renderSeriesList(): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;

    if (cachedSeries) {
        renderPage(app);
        setupScrollTracking();
        requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
        return;
    }

    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;

    try {
        const data = await api.getSeries(username, showHidden);
        cachedSeries = data.series;
        cachedStandalones = data.standalones || [];
        savedScrollY = 0;
        renderPage(app);
        setupScrollTracking();
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load series: ${err.message}
            </div>
        `;
    }
}

function renderPage(app: HTMLElement): void {
    app.innerHTML =
        filterBarHtml(currentState, {
            filterOptions: SERIES_FILTER_OPTIONS,
            sortOptions: SERIES_SORT_OPTIONS,
            showRated: false,
        }) +
        `<div class="mb-3 d-flex gap-4">
            <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" id="show-hidden-toggle"
                       ${showHidden ? 'checked' : ''}>
                <label class="form-check-label text-muted small" for="show-hidden-toggle">
                    Show hidden series
                </label>
            </div>
            <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" id="show-ongoing-toggle"
                       ${showOngoing ? 'checked' : ''}>
                <label class="form-check-label text-muted small" for="show-ongoing-toggle">
                    Show ongoing series
                </label>
            </div>
        </div>` +
        '<div id="series-grid-container"></div>';

    attachFilterHandlers(app, (state) => {
        currentState = state;
        applyFilters();
    });

    const toggle = app.querySelector('#show-hidden-toggle') as HTMLInputElement;
    if (toggle) {
        toggle.addEventListener('change', () => {
            showHidden = toggle.checked;
            cachedSeries = null;
            renderSeriesList();
        });
    }

    const ongoingToggle = app.querySelector('#show-ongoing-toggle') as HTMLInputElement;
    if (ongoingToggle) {
        ongoingToggle.addEventListener('change', () => {
            showOngoing = ongoingToggle.checked;
            applyFilters();
        });
    }

    applyFilters();
}

function applyFilters(): void {
    if (!cachedSeries) return;
    const standalones = cachedStandalones || [];

    let filteredSeries = cachedSeries;
    let filteredStandalones = standalones;

    // Hide ongoing series unless toggle is on or ongoing filter is active
    if (!showOngoing && currentState.filter !== 'ongoing') {
        filteredSeries = filteredSeries.filter(s => s.series_complete !== 0);
    }

    // Search: match against series name + authors; or standalone title + authors
    if (currentState.q) {
        const q = currentState.q.toLowerCase();
        filteredSeries = filteredSeries.filter(s =>
            s.series.toLowerCase().includes(q) ||
            (s.authors && s.authors.toLowerCase().includes(q))
        );
        filteredStandalones = filteredStandalones.filter(b =>
            (b.title && b.title.toLowerCase().includes(q)) ||
            (b.authors && b.authors.toLowerCase().includes(q))
        );
    }

    // Filter dropdown (series-specific filters drop standalones for relevance)
    const f = currentState.filter;
    if (f === 'complete') {
        filteredSeries = filteredSeries.filter(s => s.read_count === s.total_books);
        filteredStandalones = filteredStandalones.filter(b => b.reading_status === 'read');
    } else if (f === 'in_progress') {
        filteredSeries = filteredSeries.filter(s => s.reading_count > 0);
        filteredStandalones = filteredStandalones.filter(b => b.reading_status === 'reading');
    } else if (f === 'unread') {
        filteredSeries = filteredSeries.filter(s => s.unread_count > 0);
        filteredStandalones = filteredStandalones.filter(
            b => b.reading_status !== 'read' && b.reading_status !== 'reading'
        );
    } else if (f === 'ongoing') {
        filteredSeries = filteredSeries.filter(s => s.series_complete === 0);
        // "Ongoing" is a series-only concept; hide standalones in this mode.
        filteredStandalones = [];
    }

    // Sort series
    const desc = currentState.order === 'desc' ? -1 : 1;
    const sort = currentState.sort;
    filteredSeries = [...filteredSeries].sort((a, b) => {
        if (sort === 'author') {
            const aa = (a.author_sort || '').toLowerCase();
            const bb = (b.author_sort || '').toLowerCase();
            return aa < bb ? -1 * desc : aa > bb ? 1 * desc : 0;
        } else if (sort === 'rating') {
            const aa = a.avg_rating ?? -1;
            const bb = b.avg_rating ?? -1;
            return (aa - bb) * desc;
        } else if (sort === 'books') {
            return (a.total_books - b.total_books) * desc;
        } else {
            const aa = a.series.toLowerCase();
            const bb = b.series.toLowerCase();
            return aa < bb ? -1 * desc : aa > bb ? 1 * desc : 0;
        }
    });

    // Sort standalones independently (books sort key has no "books" axis)
    filteredStandalones = [...filteredStandalones].sort((a, b) => {
        if (sort === 'author') {
            const aa = (a.author_sort || a.authors || '').toLowerCase();
            const bb = (b.author_sort || b.authors || '').toLowerCase();
            return aa < bb ? -1 * desc : aa > bb ? 1 * desc : 0;
        } else if (sort === 'rating') {
            const aa = a.rating ?? -1;
            const bb = b.rating ?? -1;
            return (aa - bb) * desc;
        } else {
            // title default (and 'books' sort falls back to title for standalones)
            const aa = (a.title || '').toLowerCase();
            const bb = (b.title || '').toLowerCase();
            return aa < bb ? -1 * desc : aa > bb ? 1 * desc : 0;
        }
    });

    // Update count: total tiles rendered
    const countEl = document.getElementById('book-count');
    if (countEl) {
        const total = filteredSeries.length + filteredStandalones.length;
        const sCount = filteredSeries.length;
        const bCount = filteredStandalones.length;
        countEl.textContent = bCount > 0
            ? `${sCount} series, ${bCount} book${bCount !== 1 ? 's' : ''} (${total} total)`
            : `${sCount} series`;
    }

    renderSeriesGrid(
        document.getElementById('series-grid-container')!,
        filteredSeries,
        filteredStandalones,
    );
}

// Category sections rendered top-to-bottom; empty sections are skipped.
export const CATEGORY_ORDER = ['Religious', 'Fiction', 'Other'];

export interface SeriesGridOpts {
    // When true, drop category headers — everything renders in a single
    // grid. Useful when the caller has already filtered to one category.
    showCategoryHeaders?: boolean;
}

export function renderSeriesGrid(
    container: HTMLElement,
    series: any[],
    standalones: any[],
    opts: SeriesGridOpts = {},
): void {
    const showHeaders = opts.showCategoryHeaders !== false;

    if (series.length === 0 && standalones.length === 0) {
        container.innerHTML = `
            <div class="text-center text-muted py-5">
                <i class="bi bi-collection" style="font-size: 3rem;"></i>
                <p class="mt-2">No books or series found</p>
            </div>
        `;
        return;
    }

    let html = '';
    if (!showHeaders) {
        // Single flat grid in caller-chosen order. Series first, then
        // standalones — matches the natural visual hierarchy.
        html += '<div class="row g-3 mb-4">';
        for (const s of series) html += renderSeriesCard(s);
        for (const b of standalones) html += renderStandaloneCard(b);
        html += '</div>';
    } else {
        // Bucket by category. Series first, then standalones — both kinds
        // share the bucket so categories render together.
        const seriesBuckets: Record<string, any[]> = {
            Religious: [], Fiction: [], Other: [],
        };
        const standaloneBuckets: Record<string, any[]> = {
            Religious: [], Fiction: [], Other: [],
        };
        for (const s of series) {
            const cat = seriesBuckets[s.category] ? s.category : 'Other';
            seriesBuckets[cat].push(s);
        }
        for (const b of standalones) {
            const cat = standaloneBuckets[b.category] ? b.category : 'Other';
            standaloneBuckets[cat].push(b);
        }

        for (const cat of CATEGORY_ORDER) {
            const seriesItems = seriesBuckets[cat] || [];
            const bookItems = standaloneBuckets[cat] || [];
            if (seriesItems.length === 0 && bookItems.length === 0) continue;
            html += `<h3 class="series-category-heading">${cat}</h3>`;
            html += '<div class="row g-3 mb-4">';
            for (const s of seriesItems) html += renderSeriesCard(s);
            for (const b of bookItems) html += renderStandaloneCard(b);
            html += '</div>';
        }
    }
    container.innerHTML = html;
    attachSeriesGridHandlers(container);
}

// Wire click handlers on a rendered series/standalone grid:
//   .series-card → series view, .standalone-card → book detail,
//   .series-author-link → home library filtered by author.
// Exported so the unified library page can reuse it.
export function attachSeriesGridHandlers(container: HTMLElement): void {
    container.querySelectorAll('.series-card').forEach(card => {
        // Standalone cards also carry .series-card for styling — filter them.
        if (card.classList.contains('standalone-card')) return;
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-series-id');
            if (id) navigate(`#/series/${id}`);
        });
    });
    container.querySelectorAll('.standalone-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-book-id');
            if (id) navigate(`#/book/${id}`);
        });
    });

    container.querySelectorAll('.series-author-link').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const author = (el as HTMLElement).dataset.authors;
            if (author) {
                setAuthorFilter(author);
                navigateHome();
            }
        });
    });
}

export function renderSeriesCard(s: any): string {
    const avgRating = s.avg_rating
        ? Math.round(s.avg_rating).toString()
        : '-';

    const notOwnedCount = s.not_owned_count || 0;
    const completionClass = s.read_count === s.total_books
        ? ' series-card-complete'
        : s.read_count > 0
            ? ' series-card-in-progress'
            : '';
    const monitoredClass = s.monitored === 0 ? ' series-card-hidden' : '';
    const ongoingClass = s.series_complete === 0 ? ' series-card-ongoing' : '';
    const ongoingBadge = s.series_complete === 0
        ? ' <span class="badge bg-warning text-dark ms-1" style="font-size:0.65rem">Ongoing</span>'
        : '';
    const notOwnedLabel = notOwnedCount > 0
        ? ` <span class="text-danger">${notOwnedCount} not owned</span>`
        : '';

    const segmentsHtml = renderSegmentedBar(
        s.status_seq || '', s.owned_seq || '',
        s.progress_seq || '', s.ghost_count || 0,
    );

    const authorHtml = s.authors
        ? `<div class="text-muted small">${s.authors.split(',').map((a: string) => {
            const trimmed = a.trim();
            return `<span class="series-author-link" data-authors="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</span>`;
        }).join(', ')}</div>`
        : '';

    // Cover comes from the series's first book (lowest series_index,
    // tiebreaker by id ascending — computed server-side). When that
    // book has no cover, fall back to a small no-cover placeholder
    // matching the .no-cover-large pattern used on book detail.
    const coverHtml = (
        s.first_book_cover_filename && s.first_book_user_id != null
    )
        ? `<div class="series-cover-wrap"><img src="${api.coverUrl(s.first_book_user_id, s.first_book_cover_filename, s.first_book_cover_updated_at)}" alt="${escapeHtml(s.series)}" class="series-cover-img" loading="lazy"></div>`
        : `<div class="series-cover-wrap"><div class="series-no-cover"><i class="bi bi-book"></i></div></div>`;

    return `
        <div class="col-6 col-sm-6 col-md-4 col-lg-3">
            <div class="card series-card${completionClass}${monitoredClass}${ongoingClass} h-100" data-series-id="${s.series_link_id}">
                ${coverHtml}
                <div class="card-body">
                    <h6 class="card-title mb-1">${escapeHtml(s.series)}${ongoingBadge}</h6>
                    ${authorHtml}
                    <div class="d-flex justify-content-between text-muted small mb-2">
                        <span>${s.total_books} book${s.total_books !== 1 ? 's' : ''}</span>
                        <span>${s.read_count}/${s.total_books} read${notOwnedLabel}</span>
                    </div>
                    ${segmentsHtml}
                    <div class="text-muted small mt-2">
                        Avg rating: ${avgRating}
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function renderStandaloneCard(b: any): string {
    // Status pill in the bottom-right of the cover.
    const status = (b.reading_status || 'unread') as string;
    const statusLabel = status === 'read'
        ? 'Read'
        : status === 'reading' ? 'Reading' : 'Unread';
    const statusClass = status === 'read'
        ? 'standalone-pill-read'
        : status === 'reading'
            ? 'standalone-pill-reading'
            : 'standalone-pill-unread';

    const authorHtml = b.authors
        ? `<div class="text-muted small">${b.authors.split(',').map((a: string) => {
            const trimmed = a.trim();
            return `<span class="series-author-link" data-authors="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</span>`;
        }).join(', ')}</div>`
        : '';

    const coverHtml = (b.cover_filename && b.cover_user_id != null)
        ? `<div class="series-cover-wrap">
               <img src="${api.coverUrl(b.cover_user_id, b.cover_filename, b.cover_updated_at)}" alt="${escapeHtml(b.title)}" class="series-cover-img" loading="lazy">
               <span class="standalone-status-pill ${statusClass}">${statusLabel}</span>
           </div>`
        : `<div class="series-cover-wrap">
               <div class="series-no-cover"><i class="bi bi-book"></i></div>
               <span class="standalone-status-pill ${statusClass}">${statusLabel}</span>
           </div>`;

    return `
        <div class="col-6 col-sm-6 col-md-4 col-lg-3">
            <div class="card series-card standalone-card h-100" data-book-id="${b.standalone_book_id}">
                ${coverHtml}
                <div class="card-body">
                    <h6 class="card-title mb-1">${escapeHtml(b.title || '')}</h6>
                    ${authorHtml}
                </div>
            </div>
        </div>
    `;
}

function setupScrollTracking(): void {
    if (scrollListener) {
        window.removeEventListener('scroll', scrollListener);
    }
    scrollListener = () => {
        if (document.getElementById('series-grid-container')) {
            savedScrollY = window.scrollY;
        }
    };
    window.addEventListener('scroll', scrollListener, { passive: true });
}

const STATUS_CLASS: Record<string, string> = {
    r: 'segment-read', b: 'segment-reading', u: 'segment-unread',
};

function renderSegmentedBar(
    statusSeq: string, ownedSeq: string, progressSeq: string,
    ghostCount: number = 0,
): string {
    const progValues = progressSeq
        ? progressSeq.split(',').map(Number)
        : [];
    const segments: string[] = [];
    // The last `ghostCount` slots are series_entries the user
    // doesn't own — render as dashed/hollow ghosts instead of
    // the not-owned (red border) treatment for placeholder books.
    const ghostStart = statusSeq.length - ghostCount;
    for (let i = 0; i < statusSeq.length; i++) {
        const isGhost = i >= ghostStart;
        const cls = STATUS_CLASS[statusSeq[i]] || 'segment-unread';
        const owned = ownedSeq[i] !== '0' ? '' : ' segment-not-owned';
        const prog = progValues[i] || 0;
        if (isGhost) {
            segments.push(`<div class="series-segment segment-ghost"></div>`);
        } else if (statusSeq[i] === 'b') {
            const pct = Math.round(prog * 100);
            segments.push(`<div class="series-segment${owned}" style="border-color:var(--bs-primary);background:linear-gradient(to right,var(--bs-primary) ${pct}%,var(--bs-secondary-bg) ${pct}%)"></div>`);
        } else {
            segments.push(`<div class="series-segment ${cls}${owned}"></div>`);
        }
    }
    return `<div class="series-segments">${segments.join('')}</div>`;
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
