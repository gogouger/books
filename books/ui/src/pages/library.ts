import { api } from '../api';
import { getLibraryUsername } from '../context';
import { bookGridHtml, attachGridClickHandlers, appendToBookGrid } from '../components/book-grid';
import {
    filterBarHtml,
    attachFilterHandlers,
    FilterState,
} from '../components/filter-bar';

let currentState: FilterState = {
    q: '',
    filter: '',
    sort: 'series',
    order: 'asc',
    rated: null,
};

const PAGE_SIZE = 60;
let pendingAuthorFilter: string | null = null;

// Infinite scroll + cache state
let allBooks: any[] = [];
let totalBooks = 0;
let savedScrollY = 0;
let isLoading = false;
let observer: IntersectionObserver | null = null;
let lastLoadedState: FilterState | null = null;
let scrollListener: (() => void) | null = null;
// When the user toggles ghost-entry overlay off (sticky across loads).
let hideUnowned = false;

const DEFAULT_STATE: FilterState = {
    q: '',
    filter: '',
    sort: 'series',
    order: 'asc',
    rated: null,
};

export function resetLibraryFilters(): void {
    currentState = { ...DEFAULT_STATE };
    allBooks = [];
    totalBooks = 0;
    savedScrollY = 0;
    lastLoadedState = null;
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
}

function statesMatch(a: FilterState, b: FilterState): boolean {
    return a.q === b.q && a.filter === b.filter && a.sort === b.sort && a.order === b.order && a.rated === b.rated;
}

function applyAuthorFilter(author: string): void {
    currentState.q = author;
    currentState.sort = 'title';

    const searchInput = document.getElementById('filter-search') as HTMLInputElement;
    if (searchInput) searchInput.value = author;
    const clearBtn = document.getElementById('filter-search-clear');
    if (clearBtn) clearBtn.classList.remove('d-none');
    const sortSelect = document.getElementById('filter-sort') as HTMLSelectElement;
    if (sortSelect) sortSelect.value = 'title';

    resetAndReload();
}

function resetAndReload(): void {
    allBooks = [];
    totalBooks = 0;
    savedScrollY = 0;
    if (observer) { observer.disconnect(); observer = null; }

    const gridContainer = document.getElementById('book-grid-container');
    if (gridContainer) gridContainer.innerHTML = '';

    loadMoreBooks();
}

export async function renderLibrary(): Promise<void> {
    const canRestore = allBooks.length > 0
        && lastLoadedState !== null
        && statesMatch(currentState, lastLoadedState)
        && !pendingAuthorFilter;

    if (pendingAuthorFilter) {
        currentState.q = pendingAuthorFilter;
        currentState.sort = 'title';
        pendingAuthorFilter = null;
    }

    const app = document.getElementById('app')!;
    app.innerHTML =
        filterBarHtml(currentState) +
        // "Hide unowned" toggle — only meaningful in sort=series mode
        // since other sorts don't request ghosts.
        `<div class="mb-2 d-flex gap-3 align-items-center small">
            <div class="form-check form-switch mb-0">
                <input class="form-check-input" type="checkbox"
                       id="hide-unowned-toggle" ${hideUnowned ? 'checked' : ''}>
                <label class="form-check-label text-muted" for="hide-unowned-toggle">
                    Hide unowned (ghost entries)
                </label>
            </div>
        </div>` +
        '<div id="book-grid-container"></div>' +
        '<div id="scroll-sentinel"></div>';

    attachFilterHandlers(app, async (state) => {
        currentState = state;
        resetAndReload();
    });

    const ghostToggle = app.querySelector('#hide-unowned-toggle') as HTMLInputElement | null;
    if (ghostToggle) {
        ghostToggle.addEventListener('change', () => {
            hideUnowned = ghostToggle.checked;
            resetAndReload();
        });
    }

    setupScrollTracking();

    if (canRestore) {
        // Restore from cache
        const gridContainer = document.getElementById('book-grid-container')!;
        const countEl = document.getElementById('book-count');
        const grouped = currentState.sort === 'series';
        gridContainer.innerHTML = bookGridHtml(allBooks, { grouped });
        attachGridClickHandlers(gridContainer, applyAuthorFilter);
        if (countEl) {
            countEl.textContent = `${totalBooks} book${totalBooks !== 1 ? 's' : ''}`;
        }
        setupInfiniteScroll();
        requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
    } else {
        // Capture scroll target before resetting — invalidateLibraryCache
        // preserves it so we can restore position after reloading data.
        const targetScrollY = savedScrollY;
        allBooks = [];
        totalBooks = 0;
        savedScrollY = 0;
        lastLoadedState = { ...currentState };
        await loadMoreBooks();

        // After cache invalidation (e.g., book edit), reload enough batches
        // to fill the page back to the previous scroll position, then restore.
        if (targetScrollY > 0 && allBooks.length < totalBooks) {
            while (allBooks.length < totalBooks) {
                const canScroll = document.documentElement.scrollHeight - window.innerHeight;
                if (canScroll >= targetScrollY) break;
                await loadMoreBooks();
            }
            requestAnimationFrame(() => window.scrollTo(0, targetScrollY));
        }
    }
}

async function loadMoreBooks(): Promise<void> {
    if (isLoading) return;
    const offset = allBooks.length;
    if (offset > 0 && offset >= totalBooks) return;

    isLoading = true;

    const username = getLibraryUsername()!;
    const gridContainer = document.getElementById('book-grid-container')!;
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
        const params: Record<string, any> = {
            sort: currentState.sort,
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

        // sort=series clusters books by series then trails standalones.
        // Don't force has_series=true — standalones still belong here.
        if (currentState.sort === 'series') {
            params.group_by_series = true;
            if (!hideUnowned) params.include_ghosts = true;
        } else if (currentState.sort === 'date_finished') {
            if (!params.reading_status) {
                params.reading_status = 'read';
            }
        }

        const data = await api.getBooks(username, params);
        totalBooks = data.total;

        const grouped = currentState.sort === 'series';
        if (isFirstBatch) {
            allBooks = data.books;
            gridContainer.innerHTML = bookGridHtml(
                data.books, { grouped },
            );
            attachGridClickHandlers(gridContainer, applyAuthorFilter);
        } else {
            allBooks = allBooks.concat(data.books);
            if (grouped) {
                // Full re-render so headers stay correct across
                // group boundaries between batches.
                gridContainer.innerHTML = bookGridHtml(
                    allBooks, { grouped: true },
                );
                attachGridClickHandlers(gridContainer, applyAuthorFilter);
            } else {
                appendToBookGrid(
                    gridContainer, data.books, applyAuthorFilter,
                );
            }
        }

        if (countEl) {
            countEl.textContent = `${totalBooks} book${totalBooks !== 1 ? 's' : ''}`;
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

function setupScrollTracking(): void {
    if (scrollListener) {
        window.removeEventListener('scroll', scrollListener);
    }
    scrollListener = () => {
        // Only track while library is displayed; navigating away replaces
        // #app content and scrolls to 0, which would clobber savedScrollY.
        if (document.getElementById('book-grid-container')) {
            savedScrollY = window.scrollY;
        }
    };
    window.addEventListener('scroll', scrollListener, { passive: true });
}
