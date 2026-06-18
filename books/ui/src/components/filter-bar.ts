export type LibraryView = 'books-grouped' | 'books-flat';
export type LibraryCategory =
    | 'all'
    | 'Religious'
    | 'Religious-commentary'
    | 'Fiction';

export interface FilterState {
    q: string;
    filter: string;
    sort: string;
    order: string;
    rated: boolean | null;
    // Optional: only used by the unified library page. Other consumers
    // (series-edit, etc.) ignore these and pass through whatever default.
    view?: LibraryView;
    category?: LibraryCategory;
}

export interface FilterOption { value: string; label: string; hr?: boolean }
export interface SortOption { value: string; label: string }

export interface ViewOption { value: LibraryView; label: string }
export interface CategoryOption { value: LibraryCategory; label: string }

export const VIEW_OPTIONS: ViewOption[] = [
    { value: 'books-grouped', label: 'Books by series' },
    { value: 'books-flat', label: 'Books (flat)' },
];

export const CATEGORY_OPTIONS: CategoryOption[] = [
    { value: 'all', label: 'All categories' },
    { value: 'Religious', label: 'Religious' },
    // Nested under Religious — the leading "  └ " is the visual cue that
    // it's a sub-shelf of Religious (commentaries also have tag=commentary).
    { value: 'Religious-commentary', label: '  └ Commentaries' },
    { value: 'Fiction', label: 'Fiction' },
];

const DEFAULT_FILTER_OPTIONS: FilterOption[] = [
    { value: '', label: 'All books' },
    { value: '_hr1', label: '', hr: true },
    { value: 'read', label: 'Read' },
    { value: 'unread', label: 'Unread' },
    { value: 'reading', label: 'Reading' },
    { value: '_hr2', label: '', hr: true },
    { value: 'owned', label: 'Owned' },
    { value: 'unowned', label: 'Unowned' },
    { value: 'no_ghosts', label: 'Hide series gaps' },
    { value: '_hr3', label: '', hr: true },
    { value: 'fmt_audiobook', label: 'Audiobook' },
    { value: 'fmt_physical', label: 'Physical' },
    { value: 'fmt_ebook', label: 'Ebook' },
    { value: '_hr4', label: '', hr: true },
    { value: 'favorites', label: 'Favorites' },
    { value: '1star', label: '1 star' },
    { value: '2star', label: '2 stars' },
    { value: '3star', label: '3 stars' },
    { value: '4star', label: '4 stars' },
    { value: '5star', label: '5 stars' },
];

const DEFAULT_SORT_OPTIONS: SortOption[] = [
    { value: 'title', label: 'Title' },
    { value: 'author', label: 'Author' },
    { value: 'date_added', label: 'Date added' },
    { value: 'date_finished', label: 'Date read' },
    { value: 'rating', label: 'Rating' },
    { value: 'series', label: 'Series' },
];

export interface FilterBarOptions {
    filterOptions?: FilterOption[];
    sortOptions?: SortOption[];
    showRated?: boolean;
    // When true, render the View selector + Category dropdown. Used by
    // the unified library page; other pages omit them.
    showView?: boolean;
    showCategory?: boolean;
}

export function filterBarHtml(
    state: FilterState,
    filterOptionsOrOpts?: FilterOption[] | FilterBarOptions,
    sortOptions?: SortOption[],
): string {
    let filters: FilterOption[];
    let sorts: SortOption[];
    let showRated = true;
    let showView = false;
    let showCategory = false;

    if (filterOptionsOrOpts && !Array.isArray(filterOptionsOrOpts)) {
        filters = filterOptionsOrOpts.filterOptions || DEFAULT_FILTER_OPTIONS;
        sorts = filterOptionsOrOpts.sortOptions || DEFAULT_SORT_OPTIONS;
        showRated = filterOptionsOrOpts.showRated !== false;
        showView = filterOptionsOrOpts.showView === true;
        showCategory = filterOptionsOrOpts.showCategory === true;
    } else {
        filters = filterOptionsOrOpts || DEFAULT_FILTER_OPTIONS;
        sorts = sortOptions || DEFAULT_SORT_OPTIONS;
    }

    let filterHtml = '';
    for (const opt of filters) {
        if (opt.hr) {
            filterHtml += '<hr class="dropdown-divider">';
        } else {
            filterHtml += `<option value="${opt.value}"${state.filter === opt.value ? ' selected' : ''}>${opt.label}</option>`;
        }
    }

    let sortHtml = '';
    for (const opt of sorts) {
        sortHtml += `<option value="${opt.value}"${state.sort === opt.value ? ' selected' : ''}>${opt.label}</option>`;
    }

    const currentView = state.view || 'books-grouped';
    let viewHtml = '';
    for (const opt of VIEW_OPTIONS) {
        viewHtml += `<option value="${opt.value}"${currentView === opt.value ? ' selected' : ''}>${opt.label}</option>`;
    }

    const currentCategory = state.category || 'all';
    let categoryHtml = '';
    for (const opt of CATEGORY_OPTIONS) {
        categoryHtml += `<option value="${opt.value}"${currentCategory === opt.value ? ' selected' : ''}>${opt.label}</option>`;
    }

    return `
        <div class="filter-bar">
            <div class="row g-2 align-items-end">
                ${showView ? `<div class="col-auto">
                    <select class="form-select" id="filter-view" title="View mode">
                        ${viewHtml}
                    </select>
                </div>` : ''}
                ${showCategory ? `<div class="col-auto">
                    <select class="form-select" id="filter-category" title="Category">
                        ${categoryHtml}
                    </select>
                </div>` : ''}
                <div class="col-auto position-relative">
                    <input type="text" class="form-control" id="filter-search"
                           placeholder="Search..."
                           value="${escapeAttr(state.q)}">
                    <button type="button" class="btn-search-clear${state.q ? '' : ' d-none'}" id="filter-search-clear"
                            title="Clear search">
                        <i class="bi bi-x-lg"></i>
                    </button>
                </div>
                <div class="col-auto">
                    <select class="form-select" id="filter-main">
                        ${filterHtml}
                    </select>
                </div>
                <div class="col-auto">
                    <select class="form-select" id="filter-sort">
                        ${sortHtml}
                    </select>
                </div>
                <div class="col-auto">
                    <button type="button" class="btn btn-outline-secondary" id="filter-order"
                            data-order="${state.order}" title="${state.order === 'asc' ? 'Ascending' : 'Descending'}">
                        <i class="bi bi-sort-${state.order === 'asc' ? 'up' : 'down'}"></i>
                    </button>
                </div>
                ${showRated ? `<div class="col-auto">
                    <button type="button" class="btn btn-outline-secondary" id="filter-rated"
                            data-rated="${state.rated}" title="${state.rated === null ? 'Showing all' : state.rated ? 'Showing rated' : 'Showing unrated'}">
                        <i class="bi bi-star${state.rated === null ? '-half' : state.rated ? '-fill' : ''}"></i>
                    </button>
                </div>` : ''}
                <div class="col-auto text-end">
                    <span class="pagination-info" id="book-count"></span>
                </div>
            </div>
        </div>
    `;
}

export function attachFilterHandlers(
    container: HTMLElement,
    onChange: (state: FilterState) => void
): void {
    let debounceTimer: ReturnType<typeof setTimeout>;

    const getState = (): FilterState => ({
        q: (container.querySelector('#filter-search') as HTMLInputElement)?.value || '',
        filter: (container.querySelector('#filter-main') as HTMLSelectElement)?.value || '',
        sort: (container.querySelector('#filter-sort') as HTMLSelectElement)?.value || 'title',
        order: (container.querySelector('#filter-order') as HTMLElement)?.dataset.order || 'asc',
        rated: (() => {
            const v = (container.querySelector('#filter-rated') as HTMLElement)?.dataset.rated;
            return v === 'true' ? true : v === 'false' ? false : null;
        })(),
        view: ((container.querySelector('#filter-view') as HTMLSelectElement)?.value || undefined) as LibraryView | undefined,
        category: ((container.querySelector('#filter-category') as HTMLSelectElement)?.value || undefined) as LibraryCategory | undefined,
    });

    const searchInput = container.querySelector('#filter-search') as HTMLInputElement;
    const clearBtn = container.querySelector('#filter-search-clear') as HTMLElement;

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            if (clearBtn) {
                clearBtn.classList.toggle('d-none', !searchInput.value);
            }
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => onChange(getState()), 300);
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            clearBtn.classList.add('d-none');
            onChange(getState());
        });
    }

    ['#filter-main', '#filter-sort', '#filter-view', '#filter-category'].forEach(sel => {
        const el = container.querySelector(sel);
        if (el) el.addEventListener('change', () => onChange(getState()));
    });

    const orderBtn = container.querySelector('#filter-order') as HTMLElement;
    if (orderBtn) {
        orderBtn.addEventListener('click', () => {
            const current = orderBtn.dataset.order || 'asc';
            const next = current === 'asc' ? 'desc' : 'asc';
            orderBtn.dataset.order = next;
            orderBtn.title = next === 'asc' ? 'Ascending' : 'Descending';
            const icon = orderBtn.querySelector('i')!;
            icon.className = `bi bi-sort-${next === 'asc' ? 'up' : 'down'}`;
            onChange(getState());
        });
    }

    const ratedBtn = container.querySelector('#filter-rated') as HTMLElement;
    if (ratedBtn) {
        ratedBtn.addEventListener('click', () => {
            const cur = ratedBtn.dataset.rated;
            // Cycle: rated -> unrated -> all -> rated
            const next = cur === 'true' ? 'false' : cur === 'false' ? 'null' : 'true';
            ratedBtn.dataset.rated = next;
            const icon = next === 'null' ? 'star-half' : next === 'true' ? 'star-fill' : 'star';
            const title = next === 'null' ? 'Showing all' : next === 'true' ? 'Showing rated' : 'Showing unrated';
            ratedBtn.title = title;
            ratedBtn.querySelector('i')!.className = `bi bi-${icon}`;
            onChange(getState());
        });
    }
}

function escapeAttr(text: string): string {
    return text.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
