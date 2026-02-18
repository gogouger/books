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

export function attachGridClickHandlers(container: HTMLElement): void {
    container.querySelectorAll('.book-card').forEach(card => {
        card.addEventListener('click', () => {
            const bookId = card.getAttribute('data-book-id');
            if (bookId) navigate(`#/book/${bookId}`);
        });
    });
}
