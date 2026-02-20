import { bookCardHtml } from './book-card';
import { navigate } from '../router';

export function bookGridHtml(books: any[]): string {
    if (books.length === 0) {
        return `
            <div class="text-center text-muted py-5">
                <i class="bi bi-book" style="font-size: 3rem;"></i>
                <p class="mt-2">No books found</p>
            </div>
        `;
    }
    const cards = books.map(b => bookCardHtml(b)).join('');
    return `<div class="book-grid">${cards}</div>`;
}

export function attachGridClickHandlers(
    container: HTMLElement,
    onAuthorClick?: (author: string) => void
): void {
    container.querySelectorAll('.book-card').forEach(card => {
        card.addEventListener('click', () => {
            const bookId = card.getAttribute('data-book-id');
            if (bookId) navigate(`#/book/${bookId}`);
        });

        if (onAuthorClick) {
            const authorEl = card.querySelector('.card-author-link');
            if (authorEl) {
                authorEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onAuthorClick(authorEl.textContent?.trim() || '');
                });
            }
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
    onAuthorClick?: (author: string) => void
): void {
    const grid = container.querySelector('.book-grid');
    if (!grid) return;

    const temp = document.createElement('div');
    temp.innerHTML = books.map(b => bookCardHtml(b)).join('');
    const newCards = Array.from(temp.children) as HTMLElement[];

    for (const card of newCards) {
        grid.appendChild(card);

        card.addEventListener('click', () => {
            const bookId = card.getAttribute('data-book-id');
            if (bookId) navigate(`#/book/${bookId}`);
        });

        if (onAuthorClick) {
            const authorEl = card.querySelector('.card-author-link');
            if (authorEl) {
                authorEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onAuthorClick(authorEl.textContent?.trim() || '');
                });
            }
        }

        const seriesLink = card.querySelector('.card-series-link');
        if (seriesLink) {
            seriesLink.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
    }
}
