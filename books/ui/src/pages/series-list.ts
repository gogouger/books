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
}

export function resetSeriesFilters(): void {
    currentState = { q: '', filter: '', sort: 'title', order: 'asc', rated: null };
    cachedSeries = null;
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

    let filtered = cachedSeries;

    // Hide ongoing series unless toggle is on or ongoing filter is active
    if (!showOngoing && currentState.filter !== 'ongoing') {
        filtered = filtered.filter(s => s.series_complete !== 0);
    }

    // Search: match against series name and authors
    if (currentState.q) {
        const q = currentState.q.toLowerCase();
        filtered = filtered.filter(s =>
            s.series.toLowerCase().includes(q) ||
            (s.authors && s.authors.toLowerCase().includes(q))
        );
    }

    // Filter dropdown
    const f = currentState.filter;
    if (f === 'complete') {
        filtered = filtered.filter(s => s.read_count === s.total_books);
    } else if (f === 'in_progress') {
        filtered = filtered.filter(s => s.reading_count > 0);
    } else if (f === 'unread') {
        filtered = filtered.filter(s => s.unread_count > 0);
    } else if (f === 'ongoing') {
        filtered = filtered.filter(s => s.series_complete === 0);
    }

    // Sort
    const desc = currentState.order === 'desc' ? -1 : 1;
    const sort = currentState.sort;
    filtered = [...filtered].sort((a, b) => {
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
            // title (default)
            const aa = a.series.toLowerCase();
            const bb = b.series.toLowerCase();
            return aa < bb ? -1 * desc : aa > bb ? 1 * desc : 0;
        }
    });

    // Update count
    const countEl = document.getElementById('book-count');
    if (countEl) {
        countEl.textContent = `${filtered.length} series`;
    }

    renderSeriesGrid(
        document.getElementById('series-grid-container')!,
        filtered,
    );
}

function renderSeriesGrid(container: HTMLElement, series: any[]): void {
    if (series.length === 0) {
        container.innerHTML = `
            <div class="text-center text-muted py-5">
                <i class="bi bi-collection" style="font-size: 3rem;"></i>
                <p class="mt-2">No series found</p>
            </div>
        `;
        return;
    }

    let html = '<div class="row g-3">';

    for (const s of series) {
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
            s.progress_seq || ''
        );

        const authorHtml = s.authors
            ? `<div class="text-muted small">${s.authors.split(',').map((a: string) => {
                const trimmed = a.trim();
                return `<span class="series-author-link" data-authors="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</span>`;
            }).join(', ')}</div>`
            : '';

        html += `
            <div class="col-12 col-sm-6 col-md-4 col-lg-3">
                <div class="card series-card${completionClass}${monitoredClass}${ongoingClass} h-100" data-series-id="${s.series_link_id}">
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

    html += '</div>';
    container.innerHTML = html;

    // Attach click handlers
    container.querySelectorAll('.series-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-series-id');
            if (id) navigate(`#/series/${id}`);
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
    statusSeq: string, ownedSeq: string, progressSeq: string
): string {
    const progValues = progressSeq
        ? progressSeq.split(',').map(Number)
        : [];
    const segments: string[] = [];
    for (let i = 0; i < statusSeq.length; i++) {
        const cls = STATUS_CLASS[statusSeq[i]] || 'segment-unread';
        const owned = ownedSeq[i] !== '0' ? '' : ' segment-not-owned';
        const prog = progValues[i] || 0;
        if (statusSeq[i] === 'b') {
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
