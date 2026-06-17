import { bookCardHtml, isHiddenShortStory } from './book-card';
import { navigate } from '../router';

export interface BookGridOptions {
    grouped?: boolean;  // emit per-series section headers
}

// Groups longer than this start collapsed in the grouped library view.
const COLLAPSE_THRESHOLD = 6;

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

    // Grouped: drop unread novellas (fractional series_index, not yet read),
    // bucket by series_link_id preserving caller sort, then emit heading +
    // grid + optional "Show all N" toggle when the group is long.
    const filtered = books.filter(b => !isHiddenShortStory(b));
    const groupOrder: string[] = [];
    const groupMap: Record<string, { heading: string; books: any[] }> = {};
    for (const b of filtered) {
        const slid = b.series_link_id ?? null;
        const key = slid === null ? '__standalones__' : String(slid);
        if (!groupMap[key]) {
            groupOrder.push(key);
            groupMap[key] = {
                heading: slid === null ? 'Standalones' : (b.series || 'Series'),
                books: [],
            };
        }
        groupMap[key].books.push(b);
    }

    let out = '';
    for (const key of groupOrder) {
        const g = groupMap[key];
        out += `<h4 class="library-group-heading">${escapeHtml(g.heading)}</h4>`;
        out += '<div class="book-grid">';
        const long = g.books.length > COLLAPSE_THRESHOLD;
        for (let i = 0; i < g.books.length; i++) {
            const card = bookCardHtml(g.books[i]);
            out += (long && i >= COLLAPSE_THRESHOLD)
                ? withClass(card, 'series-collapsed-extra')
                : card;
        }
        out += '</div>';
        if (long) {
            out += `<button type="button" class="btn btn-link btn-sm series-expand-toggle" data-total="${g.books.length}">Show all ${g.books.length}</button>`;
        }
    }
    return out;
}

// Inject an extra class onto the .book-card root emitted by bookCardHtml.
// The card opens with `class="book-card card...`; slot the new class in.
function withClass(html: string, cls: string): string {
    return html.replace('class="book-card card', `class="book-card card ${cls}`);
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

    container.querySelectorAll<HTMLButtonElement>('.series-expand-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const grid = btn.previousElementSibling as HTMLElement | null;
            if (!grid || !grid.classList.contains('book-grid')) return;
            const expanding = !grid.classList.contains('series-expanded');
            grid.classList.toggle('series-expanded', expanding);
            const total = btn.dataset.total || '0';
            btn.textContent = expanding ? 'Collapse' : `Show all ${total}`;
        });
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
