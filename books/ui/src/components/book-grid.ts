import { bookCardHtml, isHiddenShortStory } from './book-card';
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

    // Grouped: drop unread novellas (fractional series_index, not yet read),
    // bucket by series_link_id preserving caller sort, then emit heading +
    // grid + a "Show all N" toggle for every group with > 1 book. The actual
    // first-row-only collapse is applied by applyRowCollapse() after mount,
    // which knows the rendered grid width and trims to exactly one row's
    // worth of cards.
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
        out += '<div class="book-grid" data-collapsible="1">';
        for (const b of g.books) out += bookCardHtml(b);
        out += '</div>';
        if (g.books.length > 1) {
            out += `<button type="button" class="btn btn-link btn-sm series-expand-toggle" data-total="${g.books.length}" hidden>Show all ${g.books.length}</button>`;
        }
    }
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

    // Trim each collapsible grid to one row's worth of cards, based on how
    // many the current viewport actually fits. Run on mount and on resize.
    applyRowCollapse(container);
    bindResizeRecollapse(container);
}

// Hide the past-first-row cards in each collapsible grid. Reads the grid's
// computed grid-template-columns so it lines up with whatever CSS @media
// breakpoint is active (180px min on desktop, 140px on mobile).
function applyRowCollapse(container: HTMLElement): void {
    const grids = container.querySelectorAll<HTMLElement>(
        '.book-grid[data-collapsible="1"]'
    );
    grids.forEach(grid => {
        // Skip expanded grids — leave them as-is until the user collapses.
        if (grid.classList.contains('series-expanded')) return;

        const cards = grid.querySelectorAll<HTMLElement>('.book-card');
        if (!cards.length) return;

        // Number of resolved column tracks = how many cards fit per row.
        const tracks = getComputedStyle(grid)
            .gridTemplateColumns
            .split(/\s+/)
            .filter(s => s && s !== '0px').length;
        const perRow = Math.max(1, tracks);

        // First-pass clear, then re-apply so resize handles both grow & shrink.
        cards.forEach(c => c.classList.remove('series-collapsed-extra'));
        for (let i = perRow; i < cards.length; i++) {
            cards[i].classList.add('series-collapsed-extra');
        }

        const toggle = grid.nextElementSibling as HTMLElement | null;
        if (toggle && toggle.classList.contains('series-expand-toggle')) {
            toggle.hidden = cards.length <= perRow;
        }
    });
}

// Re-run applyRowCollapse on viewport resize. Debounced; idempotent.
let resizeBound = false;
function bindResizeRecollapse(container: HTMLElement): void {
    if (resizeBound) return;
    resizeBound = true;
    let t: number | undefined;
    window.addEventListener('resize', () => {
        if (t) window.clearTimeout(t);
        t = window.setTimeout(() => applyRowCollapse(container), 120);
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
