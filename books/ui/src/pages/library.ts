import { api } from '../api';
import { getLibraryUsername } from '../context';
import { bookGridHtml, attachGridClickHandlers, appendToBookGrid } from '../components/book-grid';
import {
    filterBarHtml,
    attachFilterHandlers,
    FilterState,
    LibraryView,
    LibraryCategory,
} from '../components/filter-bar';
import {
    renderSeriesGrid,
    attachSeriesGridHandlers,
} from './series-list';

let currentState: FilterState = {
    q: '',
    filter: '',
    sort: 'series',
    order: 'asc',
    rated: null,
    view: 'books-grouped',
    category: 'all',
};

const PAGE_SIZE = 60;
let pendingAuthorFilter: string | null = null;

// Infinite scroll + cache state (books views only — series-cards loads once).
let allBooks: any[] = [];
let totalBooks = 0;
let savedScrollY = 0;
let isLoading = false;
let observer: IntersectionObserver | null = null;
let lastLoadedState: FilterState | null = null;
let scrollListener: (() => void) | null = null;
// When the user toggles ghost-entry overlay off (sticky across loads).
let hideUnowned = false;

// Series-cards view cache (separate from books cache).
let cachedSeries: any[] | null = null;
let cachedStandalones: any[] | null = null;

const DEFAULT_STATE: FilterState = {
    q: '',
    filter: '',
    sort: 'series',
    order: 'asc',
    rated: null,
    view: 'books-grouped',
    category: 'all',
};

export function resetLibraryFilters(): void {
    currentState = { ...DEFAULT_STATE };
    allBooks = [];
    totalBooks = 0;
    savedScrollY = 0;
    lastLoadedState = null;
    cachedSeries = null;
    cachedStandalones = null;
}

export function setAuthorFilter(author: string): void {
    pendingAuthorFilter = author;
}

// Patch a single book's fields in the cache (for inline edits)
export function updateCachedBook(bookId: number, updates: Record<string, any>): void {
    const book = allBooks.find(b => b.id === bookId);
    if (book) Object.assign(book, updates);
}

// Invalidate entire cache (for full form edits that change sort order).
// Preserves savedScrollY so the library can restore scroll position on re-render.
export function invalidateLibraryCache(): void {
    allBooks = [];
    totalBooks = 0;
    lastLoadedState = null;
    cachedSeries = null;
    cachedStandalones = null;
}

function statesMatch(a: FilterState, b: FilterState): boolean {
    return a.q === b.q && a.filter === b.filter && a.sort === b.sort
        && a.order === b.order && a.rated === b.rated
        && a.view === b.view && a.category === b.category;
}

function applyAuthorFilter(author: string): void {
    currentState.q = author;
    currentState.sort = 'title';
    // Author filter only makes sense in a books view — drop out of cards.
    if (currentState.view === 'series-cards') currentState.view = 'books-flat';

    const searchInput = document.getElementById('filter-search') as HTMLInputElement;
    if (searchInput) searchInput.value = author;
    const clearBtn = document.getElementById('filter-search-clear');
    if (clearBtn) clearBtn.classList.remove('d-none');
    const sortSelect = document.getElementById('filter-sort') as HTMLSelectElement;
    if (sortSelect) sortSelect.value = 'title';

    syncUrlHash();
    resetAndReload();
}

function resetAndReload(): void {
    allBooks = [];
    totalBooks = 0;
    savedScrollY = 0;
    if (observer) { observer.disconnect(); observer = null; }
    renderShell();
}

// Apply view/category presets coming from the router (e.g. /series). Also
// applies whatever the URL hash currently encodes so refresh works.
function applyPresetFromParams(params: Record<string, string>): void {
    const view = params.view;
    if (view === 'books-grouped' || view === 'series-cards' || view === 'books-flat') {
        currentState.view = view;
        // Keep sort in sync with view so books-grouped uses series sort.
        if (view === 'books-grouped') currentState.sort = 'series';
        else if (view === 'books-flat' && currentState.sort === 'series') {
            currentState.sort = 'title';
        }
    }
    const cat = params.category;
    if (cat === 'all' || cat === 'Religious' || cat === 'Fiction') {
        currentState.category = cat;
    }
}

// Update the URL hash to reflect current view/category without triggering
// the router (we use replaceState so back-button still works naturally).
function syncUrlHash(): void {
    const view = currentState.view || 'books-grouped';
    const category = currentState.category || 'all';
    const path = window.location.hash.split('?')[0] || '';
    const sp = new URLSearchParams();
    if (view !== 'books-grouped') sp.set('view', view);
    if (category !== 'all') sp.set('category', category);
    const qs = sp.toString();
    const newHash = qs ? `${path || '#/'}?${qs}` : path;
    if (newHash !== window.location.hash) {
        history.replaceState(null, '', window.location.pathname + (newHash || ''));
    }
}

export async function renderLibrary(params: Record<string, string> = {}): Promise<void> {
    applyPresetFromParams(params);

    if (pendingAuthorFilter) {
        currentState.q = pendingAuthorFilter;
        currentState.sort = 'title';
        if (currentState.view === 'series-cards') currentState.view = 'books-flat';
        pendingAuthorFilter = null;
    }

    syncUrlHash();
    renderShell();
}

// Render the page shell (filter bar + content host) and dispatch to the
// right content renderer based on currentState.view.
function renderShell(): void {
    const app = document.getElementById('app')!;
    const isSeriesView = currentState.view === 'series-cards';

    app.innerHTML =
        filterBarHtml(currentState, {
            showView: true,
            showCategory: true,
        }) +
        // "Hide unowned" toggle — only meaningful in books-grouped mode
        // since other views don't request ghosts.
        (isSeriesView
            ? ''
            : `<div class="mb-2 d-flex gap-3 align-items-center small">
                <div class="form-check form-switch mb-0">
                    <input class="form-check-input" type="checkbox"
                           id="hide-unowned-toggle" ${hideUnowned ? 'checked' : ''}>
                    <label class="form-check-label text-muted" for="hide-unowned-toggle">
                        Hide unowned (ghost entries)
                    </label>
                </div>
            </div>`) +
        '<div id="library-content"></div>' +
        '<div id="scroll-sentinel"></div>';

    attachFilterHandlers(app, async (state) => {
        const viewChanged = state.view !== currentState.view;
        const categoryChanged = state.category !== currentState.category;
        currentState = state;

        // View change: re-sync the implicit sort so books-grouped uses
        // series sort. Don't override user's explicit sort otherwise.
        if (viewChanged && state.view === 'books-grouped') {
            currentState.sort = 'series';
        } else if (viewChanged && state.view === 'books-flat' && state.sort === 'series') {
            currentState.sort = 'title';
        }

        syncUrlHash();

        if (viewChanged || categoryChanged) {
            // Different view/category means a different render path entirely.
            resetAndReload();
        } else {
            resetAndReload();
        }
    });

    const ghostToggle = app.querySelector('#hide-unowned-toggle') as HTMLInputElement | null;
    if (ghostToggle) {
        ghostToggle.addEventListener('change', () => {
            hideUnowned = ghostToggle.checked;
            resetAndReload();
        });
    }

    setupScrollTracking();

    if (isSeriesView) {
        renderSeriesCardsView();
    } else {
        renderBooksView();
    }
}

// === Books views (books-grouped + books-flat) ============================

async function renderBooksView(): Promise<void> {
    const canRestore = allBooks.length > 0
        && lastLoadedState !== null
        && statesMatch(currentState, lastLoadedState);

    if (canRestore) {
        const gridContainer = document.getElementById('library-content')!;
        const countEl = document.getElementById('book-count');
        const grouped = currentState.view === 'books-grouped';
        const filtered = applyClientCategoryFilter(allBooks);
        gridContainer.innerHTML = bookGridHtml(filtered, { grouped });
        attachGridClickHandlers(gridContainer, applyAuthorFilter);
        if (countEl) {
            const n = filtered.length;
            countEl.textContent = `${n} book${n !== 1 ? 's' : ''}`;
        }
        setupInfiniteScroll();
        requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
        return;
    }

    const targetScrollY = savedScrollY;
    allBooks = [];
    totalBooks = 0;
    savedScrollY = 0;
    lastLoadedState = { ...currentState };
    await loadMoreBooks();

    if (targetScrollY > 0 && allBooks.length < totalBooks) {
        while (allBooks.length < totalBooks) {
            const canScroll = document.documentElement.scrollHeight - window.innerHeight;
            if (canScroll >= targetScrollY) break;
            await loadMoreBooks();
        }
        requestAnimationFrame(() => window.scrollTo(0, targetScrollY));
    }
}

// Client-side category filter. Server returns category on each book.
function applyClientCategoryFilter(books: any[]): any[] {
    const cat = currentState.category || 'all';
    if (cat === 'all') return books;
    return books.filter(b => b.category === cat);
}

async function loadMoreBooks(): Promise<void> {
    if (isLoading) return;
    const offset = allBooks.length;
    if (offset > 0 && offset >= totalBooks) return;

    isLoading = true;

    const username = getLibraryUsername()!;
    const gridContainer = document.getElementById('library-content')!;
    const sentinel = document.getElementById('scroll-sentinel');
    const countEl = document.getElementById('book-count');
    const isFirstBatch = offset === 0;

    if (isFirstBatch) {
        gridContainer.innerHTML = `
            <div class="loading-spinner">
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
            </div>
        `;
    } else if (sentinel) {
        sentinel.innerHTML = `
            <div class="loading-spinner">
                <div class="spinner-border spinner-border-sm text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
            </div>
        `;
    }

    try {
        // Effective sort: books-grouped forces series, books-flat respects
        // user's sort but defaults to title when state still says series.
        let effectiveSort = currentState.sort;
        if (currentState.view === 'books-grouped') effectiveSort = 'series';
        else if (currentState.view === 'books-flat' && effectiveSort === 'series') {
            effectiveSort = 'title';
        }

        const params: Record<string, any> = {
            sort: effectiveSort,
            order: currentState.order,
            limit: PAGE_SIZE,
            offset: offset,
        };
        if (currentState.q) params.q = currentState.q;
        if (currentState.rated !== null) params.rated = currentState.rated;

        // Map filter dropdown to API params
        const f = currentState.filter;
        if (f === 'read' || f === 'unread' || f === 'reading') {
            params.reading_status = f;
        } else if (f === 'owned') {
            params.is_owned = true;
        } else if (f === 'unowned') {
            params.is_owned = false;
        } else if (f === 'favorites') {
            params.is_favorite = true;
        } else if (f.endsWith('star')) {
            const stars = parseInt(f);
            params.min_rating = stars;
            params.max_rating = stars;
        }

        if (effectiveSort === 'series') {
            params.group_by_series = true;
            if (!hideUnowned) params.include_ghosts = true;
        } else if (effectiveSort === 'date_finished') {
            if (!params.reading_status) {
                params.reading_status = 'read';
            }
        }

        const data = await api.getBooks(username, params);
        totalBooks = data.total;

        const grouped = currentState.view === 'books-grouped';
        if (isFirstBatch) {
            allBooks = data.books;
            const filtered = applyClientCategoryFilter(allBooks);
            gridContainer.innerHTML = bookGridHtml(filtered, { grouped });
            attachGridClickHandlers(gridContainer, applyAuthorFilter);
        } else {
            allBooks = allBooks.concat(data.books);
            if (grouped || (currentState.category && currentState.category !== 'all')) {
                // Full re-render so headers stay correct across group
                // boundaries between batches, and so client category
                // filter applies to all loaded rows.
                const filtered = applyClientCategoryFilter(allBooks);
                gridContainer.innerHTML = bookGridHtml(filtered, { grouped });
                attachGridClickHandlers(gridContainer, applyAuthorFilter);
            } else {
                appendToBookGrid(gridContainer, data.books, applyAuthorFilter);
            }
        }

        if (countEl) {
            // When client-filtering by category we report the visible
            // count instead of server total (which doesn't know).
            const cat = currentState.category || 'all';
            if (cat !== 'all') {
                const n = applyClientCategoryFilter(allBooks).length;
                countEl.textContent = `${n} book${n !== 1 ? 's' : ''} (filtered)`;
            } else {
                countEl.textContent = `${totalBooks} book${totalBooks !== 1 ? 's' : ''}`;
            }
        }
        if (sentinel) sentinel.innerHTML = '';

        lastLoadedState = { ...currentState };
        setupInfiniteScroll();
    } catch (err: any) {
        if (isFirstBatch) {
            gridContainer.innerHTML = `
                <div class="alert alert-danger">
                    Failed to load books: ${err.message}
                </div>
            `;
        }
        if (sentinel) sentinel.innerHTML = '';
    } finally {
        isLoading = false;
    }
}

function setupInfiniteScroll(): void {
    if (observer) { observer.disconnect(); observer = null; }
    if (currentState.view === 'series-cards') return;
    if (allBooks.length >= totalBooks) return;

    const sentinel = document.getElementById('scroll-sentinel');
    if (!sentinel) return;

    observer = new IntersectionObserver(
        (entries) => {
            if (entries[0].isIntersecting) {
                loadMoreBooks();
            }
        },
        { rootMargin: '400px' }
    );
    observer.observe(sentinel);
}

// === Series-cards view ===================================================

async function renderSeriesCardsView(): Promise<void> {
    const username = getLibraryUsername()!;
    const gridContainer = document.getElementById('library-content')!;
    const countEl = document.getElementById('book-count');

    if (!cachedSeries) {
        gridContainer.innerHTML = `
            <div class="loading-spinner">
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
            </div>
        `;
        try {
            const data = await api.getSeries(username, false);
            cachedSeries = data.series || [];
            cachedStandalones = data.standalones || [];
        } catch (err: any) {
            gridContainer.innerHTML = `
                <div class="alert alert-danger">
                    Failed to load series: ${err.message}
                </div>
            `;
            return;
        }
    }

    // Hide ongoing series in this view (matches /series page default).
    let series = (cachedSeries || []).filter(s => s.series_complete !== 0);
    let standalones = (cachedStandalones || []).slice();

    // Apply category filter
    const cat = currentState.category || 'all';
    if (cat !== 'all') {
        series = series.filter(s => s.category === cat);
        standalones = standalones.filter(b => b.category === cat);
    }

    // Apply text search across name/author/title
    if (currentState.q) {
        const q = currentState.q.toLowerCase();
        series = series.filter(s =>
            s.series.toLowerCase().includes(q) ||
            (s.authors && s.authors.toLowerCase().includes(q))
        );
        standalones = standalones.filter(b =>
            (b.title && b.title.toLowerCase().includes(q)) ||
            (b.authors && b.authors.toLowerCase().includes(q))
        );
    }

    // Sort: respect the filter-bar sort selection where it makes sense.
    const desc = currentState.order === 'desc' ? -1 : 1;
    const sort = currentState.sort;
    series = [...series].sort((a, b) => {
        if (sort === 'author') {
            const aa = (a.author_sort || '').toLowerCase();
            const bb = (b.author_sort || '').toLowerCase();
            return aa < bb ? -1 * desc : aa > bb ? 1 * desc : 0;
        } else if (sort === 'rating') {
            return ((a.avg_rating ?? -1) - (b.avg_rating ?? -1)) * desc;
        } else {
            const aa = a.series.toLowerCase();
            const bb = b.series.toLowerCase();
            return aa < bb ? -1 * desc : aa > bb ? 1 * desc : 0;
        }
    });
    standalones = [...standalones].sort((a, b) => {
        if (sort === 'author') {
            const aa = (a.author_sort || a.authors || '').toLowerCase();
            const bb = (b.author_sort || b.authors || '').toLowerCase();
            return aa < bb ? -1 * desc : aa > bb ? 1 * desc : 0;
        } else if (sort === 'rating') {
            return ((a.rating ?? -1) - (b.rating ?? -1)) * desc;
        } else {
            const aa = (a.title || '').toLowerCase();
            const bb = (b.title || '').toLowerCase();
            return aa < bb ? -1 * desc : aa > bb ? 1 * desc : 0;
        }
    });

    if (countEl) {
        const s = series.length;
        const b = standalones.length;
        const total = s + b;
        countEl.textContent = b > 0
            ? `${s} series, ${b} book${b !== 1 ? 's' : ''} (${total} total)`
            : `${s} series`;
    }

    // Headers only when showing all categories; specific category collapses
    // to a single flat grid.
    renderSeriesGrid(gridContainer, series, standalones, {
        showCategoryHeaders: cat === 'all',
    });
    attachSeriesGridHandlers(gridContainer);

    lastLoadedState = { ...currentState };
}

function setupScrollTracking(): void {
    if (scrollListener) {
        window.removeEventListener('scroll', scrollListener);
    }
    scrollListener = () => {
        // Only track while library is displayed; navigating away replaces
        // #app content and scrolls to 0, which would clobber savedScrollY.
        if (document.getElementById('library-content')) {
            savedScrollY = window.scrollY;
        }
    };
    window.addEventListener('scroll', scrollListener, { passive: true });
}
