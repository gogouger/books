import { bookCardHtml } from './book-card';
import { navigate } from '../router';

export interface BookGridOptions {
    grouped?: boolean;  // emit per-series section headers
}

export function bookGridHtml(
    books: any[],
    opts: BookGridOptions = {},
): string {
    if (books.length === 0) {
        return `
            <div class="text-center text-muted py-5">
                <i class="bi bi-book" style="font-size: 3rem;"></i>
                <p class="mt-2">No books found</p>
            </div>
        `;
    }
    if (!opts.grouped) {
        const cards = books.map(b => bookCardHtml(b)).join('');
        return `<div class="book-grid">${cards}</div>`;
    }

    // Grouped: emit a header whenever the series_link_id changes.
    let out = '';
    let lastKey: string | null = null;
    let openGrid = false;
    const flushOpen = () => {
        if (openGrid) {
            out += '</div>';
            openGrid = false;
        }
    };
    for (const b of books) {
        const slid = b.series_link_id ?? null;
        const groupKey = slid === null ? '__standalones__' : String(slid);
        if (groupKey !== lastKey) {
            flushOpen();
            const heading = slid === null
                ? 'Standalones'
                : (b.series || 'Series');
            out += `<h4 class="library-group-heading">${escapeHtml(heading)}</h4>`;
            out += '<div class="book-grid">';
            openGrid = true;
            lastKey = groupKey;
        }
        out += bookCardHtml(b);
    }
    flushOpen();
    return out;
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function attachGridClickHandlers(
    container: HTMLElement,
    onAuthorClick?: (author: string) => void
): void {
    container.querySelectorAll('.book-card').forEach(card => {
        const addHref = card.getAttribute('data-add-href');
        card.addEventListener('click', () => {
            if (addHref) { navigate(addHref); return; }
            const bookId = card.getAttribute('data-book-id');
            if (bookId) navigate(`#/book/${bookId}`);
        });

        if (onAuthorClick) {
            card.querySelectorAll('.card-author-link').forEach(authorEl => {
                authorEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const author = (authorEl as HTMLElement).dataset.author || '';
                    if (author) onAuthorClick(author);
                });
            });
        }

        const seriesLink = card.querySelector('.card-series-link');
        if (seriesLink) {
            seriesLink.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
    });
}

export function appendToBookGrid(
    container: HTMLElement,
    books: any[],
    onAuthorClick?: (author: string) => void,
    opts: BookGridOptions = {},
): void {
    if (opts.grouped) {
        // For grouped mode, rebuild the markup so we get a fresh set
        // of headers + grids. Simpler than tracking per-group grids.
        // Collect existing books from the container? Easier: replace.
        // We rely on the caller (library.ts) keeping `allBooks` so a
        // full re-render is cheap.
        return;
    }
    const grid = container.querySelector('.book-grid');
    if (!grid) return;

    const temp = document.createElement('div');
    temp.innerHTML = books.map(b => bookCardHtml(b)).join('');
    const newCards = Array.from(temp.children) as HTMLElement[];

    for (const card of newCards) {
        grid.appendChild(card);

        const addHref = card.getAttribute('data-add-href');
        card.addEventListener('click', () => {
            if (addHref) { navigate(addHref); return; }
            const bookId = card.getAttribute('data-book-id');
            if (bookId) navigate(`#/book/${bookId}`);
        });

        if (onAuthorClick) {
            card.querySelectorAll('.card-author-link').forEach(authorEl => {
                authorEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const author = (authorEl as HTMLElement).dataset.author || '';
                    if (author) onAuthorClick(author);
                });
            });
        }

        const seriesLink = card.querySelector('.card-series-link');
        if (seriesLink) {
            seriesLink.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
    }
}
