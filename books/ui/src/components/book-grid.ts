import { bookCardHtml, isHiddenShortStory } from './book-card';
import { navigate } from '../router';
import { api } from '../api';
import { getLibraryUsername } from '../context';

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
        card.addEventListener('click', (ev) => {
            // Inline-interactive controls handle themselves; never navigate.
            const t = ev.target as HTMLElement;
            if (t.closest('.card-star, .card-heart, .card-author-link, .card-series-link, .card-stamp[href]')) return;
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

        card.querySelectorAll('.card-series-link, .card-stamp').forEach(link => {
            link.addEventListener('click', (e) => e.stopPropagation());
        });
    });

    // Star + heart inline-interactivity. Same semantics as the rec page:
    // click a star to rate-as-read, click the heart to toggle favourite.
    wireInlineRatings(container);

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
        card.addEventListener('click', (ev) => {
            const t = ev.target as HTMLElement;
            if (t.closest('.card-star, .card-heart, .card-author-link, .card-series-link, .card-stamp[href]')) return;
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

        card.querySelectorAll('.card-series-link, .card-stamp').forEach(link => {
            link.addEventListener('click', (e) => e.stopPropagation());
        });
    }

    // The appended cards still need star/heart wiring — the original
    // listener is delegated on `container`, which already covers new
    // children, so nothing else to do here.
}

// Inline-rating delegation. Handles star hover preview + click-to-rate
// and click-to-favourite for any .book-card under `container`. Idempotent:
// uses a marker attribute so callers can wire repeatedly without doubling
// up listeners (eg. when navigating between routes that re-render).
function wireInlineRatings(container: HTMLElement): void {
    if ((container as any)._inlineRatingsBound) return;
    (container as any)._inlineRatingsBound = true;

    let hoverGroup: HTMLElement | null = null;

    container.addEventListener('mouseover', (ev) => {
        const star = (ev.target as HTMLElement).closest<HTMLElement>('.card-star');
        if (!star) return;
        const group = star.parentElement as HTMLElement | null;
        if (!group) return;
        hoverGroup = group;
        const v = parseInt(star.dataset.val || '0', 10);
        group.querySelectorAll<HTMLElement>('.card-star').forEach((s, i) => {
            s.classList.toggle('hovered', i < v);
        });
    });
    container.addEventListener('mouseout', (ev) => {
        const star = (ev.target as HTMLElement).closest<HTMLElement>('.card-star');
        if (!star) return;
        setTimeout(() => {
            if (!hoverGroup) return;
            if (!hoverGroup.matches(':hover')) {
                hoverGroup.querySelectorAll<HTMLElement>('.card-star')
                    .forEach(s => s.classList.remove('hovered'));
                hoverGroup = null;
            }
        }, 0);
    });

    container.addEventListener('click', async (ev) => {
        const target = ev.target as HTMLElement;
        const star = target.closest<HTMLElement>('.card-star');
        const heart = target.closest<HTMLElement>('.card-heart');
        if (!star && !heart) return;

        const card = target.closest<HTMLElement>('.book-card');
        const bookId = parseInt(card?.dataset.bookId || '0', 10);
        if (!card || !bookId) return;

        ev.stopPropagation();
        ev.preventDefault();
        const username = getLibraryUsername();
        if (!username) return;

        try {
            if (star) {
                const v = parseInt(star.dataset.val || '0', 10);
                if (!v) return;
                await api.updateBook(username, bookId, {
                    rating: v,
                    reading_status: 'read',
                });
                setCardRating(card, v);
            } else if (heart) {
                const next = card.dataset.favorite !== '1';
                await api.updateBook(username, bookId, {
                    is_favorite: next,
                });
                setCardFavorite(card, next);
            }
        } catch (err: any) {
            alert(`Update failed: ${err.message || err}`);
        }
    });
}

function setCardRating(card: HTMLElement, value: number): void {
    card.dataset.rating = String(value);
    card.querySelectorAll<HTMLElement>('.card-star').forEach((s, i) => {
        s.classList.toggle('filled', i < value);
        s.classList.remove('hovered');
    });
    // Flip the bottom-of-cover accent to read-green since rating implies read.
    const status = card.querySelector<HTMLElement>('.cover-status');
    if (status) {
        status.classList.remove('status-reading', 'status-unread');
        status.classList.add('status-read');
    }
}

function setCardFavorite(card: HTMLElement, on: boolean): void {
    card.dataset.favorite = on ? '1' : '0';
    const btn = card.querySelector<HTMLElement>('.card-heart');
    if (btn) btn.classList.toggle('on', on);
}
