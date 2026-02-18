import { api } from '../api';
import { bookGridHtml, attachGridClickHandlers } from '../components/book-grid';
import {
    filterBarHtml,
    attachFilterHandlers,
    FilterState,
} from '../components/filter-bar';

let currentState: FilterState = {
    q: '',
    is_read: '',
    sort: 'title',
    order: 'asc',
};
let currentOffset = 0;
const PAGE_SIZE = 60;

export async function renderLibrary(): Promise<void> {
    const app = document.getElementById('app')!;
    app.innerHTML =
        filterBarHtml(currentState) +
        '<div id="book-grid-container"></div>' +
        '<div id="pagination-container" class="d-flex justify-content-center mt-3 mb-4"></div>';

    attachFilterHandlers(app, async (state) => {
        currentState = state;
        currentOffset = 0;
        await loadBooks();
    });

    await loadBooks();
}

async function loadBooks(): Promise<void> {
    const gridContainer = document.getElementById('book-grid-container')!;
    const paginationContainer = document.getElementById('pagination-container')!;
    const countEl = document.getElementById('book-count');

    gridContainer.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;

    try {
        const params: Record<string, any> = {
            sort: currentState.sort,
            order: currentState.order,
            limit: PAGE_SIZE,
            offset: currentOffset,
        };
        if (currentState.q) params.q = currentState.q;
        if (currentState.is_read !== '') params.is_read = currentState.is_read;

        const data = await api.getBooks(params);
        gridContainer.innerHTML = bookGridHtml(data.books);
        attachGridClickHandlers(gridContainer);

        if (countEl) {
            countEl.textContent = `${data.total} book${data.total !== 1 ? 's' : ''}`;
        }

        // Pagination
        const totalPages = Math.ceil(data.total / PAGE_SIZE);
        const currentPage = Math.floor(currentOffset / PAGE_SIZE) + 1;

        if (totalPages > 1) {
            paginationContainer.innerHTML = paginationHtml(currentPage, totalPages);
            attachPaginationHandlers(paginationContainer, totalPages);
        } else {
            paginationContainer.innerHTML = '';
        }
    } catch (err: any) {
        gridContainer.innerHTML = `
            <div class="alert alert-danger">
                Failed to load books: ${err.message}
            </div>
        `;
    }
}

function paginationHtml(current: number, total: number): string {
    let html = '<nav><ul class="pagination pagination-sm">';

    html += `<li class="page-item${current === 1 ? ' disabled' : ''}">
        <a class="page-link" href="#" data-page="${current - 1}">Prev</a></li>`;

    const start = Math.max(1, current - 2);
    const end = Math.min(total, current + 2);

    if (start > 1) {
        html += `<li class="page-item"><a class="page-link" href="#" data-page="1">1</a></li>`;
        if (start > 2) html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
    }

    for (let i = start; i <= end; i++) {
        html += `<li class="page-item${i === current ? ' active' : ''}">
            <a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
    }

    if (end < total) {
        if (end < total - 1) html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
        html += `<li class="page-item"><a class="page-link" href="#" data-page="${total}">${total}</a></li>`;
    }

    html += `<li class="page-item${current === total ? ' disabled' : ''}">
        <a class="page-link" href="#" data-page="${current + 1}">Next</a></li>`;

    html += '</ul></nav>';
    return html;
}

function attachPaginationHandlers(
    container: HTMLElement,
    totalPages: number
): void {
    container.querySelectorAll('.page-link[data-page]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const page = parseInt(
                (e.target as HTMLElement).dataset.page || '1'
            );
            if (page >= 1 && page <= totalPages) {
                currentOffset = (page - 1) * PAGE_SIZE;
                loadBooks();
                window.scrollTo(0, 0);
            }
        });
    });
}
