export interface FilterState {
    q: string;
    filter: string;
    sort: string;
    order: string;
}

export interface FilterOption { value: string; label: string; hr?: boolean }
export interface SortOption { value: string; label: string }

const DEFAULT_FILTER_OPTIONS: FilterOption[] = [
    { value: '', label: 'All books' },
    { value: '_hr1', label: '', hr: true },
    { value: 'read', label: 'Read' },
    { value: 'unread', label: 'Unread' },
    { value: 'reading', label: 'Reading' },
    { value: '_hr2', label: '', hr: true },
    { value: 'owned', label: 'Owned' },
    { value: 'unowned', label: 'Unowned' },
    { value: '_hr3', label: '', hr: true },
    { value: 'favorites', label: 'Favorites' },
    { value: 'unrated', label: 'Unrated' },
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

export function filterBarHtml(
    state: FilterState,
    filterOptions?: FilterOption[],
    sortOptions?: SortOption[],
): string {
    const filters = filterOptions || DEFAULT_FILTER_OPTIONS;
    const sorts = sortOptions || DEFAULT_SORT_OPTIONS;

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

    return `
        <div class="filter-bar">
            <div class="row g-2 align-items-end">
                <div class="col-auto">
                    <input type="text" class="form-control" id="filter-search"
                           placeholder="Search..."
                           value="${escapeAttr(state.q)}">
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
    });

    const searchInput = container.querySelector('#filter-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => onChange(getState()), 300);
        });
    }

    ['#filter-main', '#filter-sort'].forEach(sel => {
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
}

function escapeAttr(text: string): string {
    return text.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
