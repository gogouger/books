export interface FilterState {
    q: string;
    is_read: string;
    sort: string;
    order: string;
}

export function filterBarHtml(state: FilterState): string {
    return `
        <div class="filter-bar">
            <div class="row g-2 align-items-end">
                <div class="col-12 col-md-4">
                    <input type="text" class="form-control" id="filter-search"
                           placeholder="Search title or author..."
                           value="${escapeAttr(state.q)}">
                </div>
                <div class="col-6 col-md-2">
                    <select class="form-select" id="filter-read">
                        <option value=""${state.is_read === '' ? ' selected' : ''}>All books</option>
                        <option value="1"${state.is_read === '1' ? ' selected' : ''}>Read</option>
                        <option value="0"${state.is_read === '0' ? ' selected' : ''}>Unread</option>
                    </select>
                </div>
                <div class="col-6 col-md-2">
                    <select class="form-select" id="filter-sort">
                        <option value="title"${state.sort === 'title' ? ' selected' : ''}>Title</option>
                        <option value="author"${state.sort === 'author' ? ' selected' : ''}>Author</option>
                        <option value="date_added"${state.sort === 'date_added' ? ' selected' : ''}>Date added</option>
                        <option value="rating"${state.sort === 'rating' ? ' selected' : ''}>Rating</option>
                        <option value="series"${state.sort === 'series' ? ' selected' : ''}>Series</option>
                    </select>
                </div>
                <div class="col-6 col-md-2">
                    <select class="form-select" id="filter-order">
                        <option value="asc"${state.order === 'asc' ? ' selected' : ''}>A-Z / Asc</option>
                        <option value="desc"${state.order === 'desc' ? ' selected' : ''}>Z-A / Desc</option>
                    </select>
                </div>
                <div class="col-6 col-md-2 text-end">
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
        is_read: (container.querySelector('#filter-read') as HTMLSelectElement)?.value || '',
        sort: (container.querySelector('#filter-sort') as HTMLSelectElement)?.value || 'title',
        order: (container.querySelector('#filter-order') as HTMLSelectElement)?.value || 'asc',
    });

    const searchInput = container.querySelector('#filter-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => onChange(getState()), 300);
        });
    }

    ['#filter-read', '#filter-sort', '#filter-order'].forEach(sel => {
        const el = container.querySelector(sel);
        if (el) el.addEventListener('change', () => onChange(getState()));
    });
}

function escapeAttr(text: string): string {
    return text.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
