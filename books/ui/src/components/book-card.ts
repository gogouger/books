import { api } from '../api';
import { ratingStarsHtml } from './rating-stars';

export function bookCardHtml(book: any): string {
    const coverImg = book.cover_filename
        ? `<img src="${api.coverUrl(book.user_id, book.cover_filename)}"
               alt="${escapeHtml(book.title)}" loading="lazy">`
        : `<div class="no-cover"><i class="bi bi-book"></i></div>`;

    const readBadge = book.is_read
        ? '<span class="badge bg-success read-badge">Read</span>'
        : '';

    const seriesInfo = book.series
        ? `<div class="card-series">${escapeHtml(book.series)}${book.series_index ? ` #${book.series_index}` : ''}</div>`
        : '';

    const stars = book.rating
        ? ratingStarsHtml(book.rating)
        : '';

    return `
        <div class="book-card card" data-book-id="${book.id}" role="button">
            <div class="cover-container">
                ${coverImg}
                ${readBadge}
            </div>
            <div class="card-body">
                <div class="card-title">${escapeHtml(book.title)}</div>
                <div class="card-author">${escapeHtml(book.authors)}</div>
                ${seriesInfo}
                ${stars}
            </div>
        </div>
    `;
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
