import { api } from '../api';

export function bookCardHtml(book: any): string {
    const coverImg = book.cover_filename
        ? `<img src="${api.coverUrl(book.user_id, book.cover_filename, book.cover_updated_at)}"
               alt="${escapeHtml(book.title)}" loading="lazy">`
        : `<div class="no-cover"><i class="bi bi-book"></i></div>`;

    const gutterClass = book.reading_status === 'read'
        ? 'gutter-read'
        : book.reading_status === 'reading'
            ? 'gutter-reading'
            : 'gutter-unread';

    const gutterFav = book.is_favorite
        ? '<i class="bi bi-heart-fill gutter-fav"></i>'
        : '';

    let gutterStars = '';
    if (book.rating) {
        for (let i = 5; i >= 1; i--) {
            const filled = i <= book.rating;
            const icon = filled ? 'bi-star-fill' : 'bi-star';
            const cls = filled ? 'gutter-star filled' : 'gutter-star';
            gutterStars += `<i class="bi ${icon} ${cls}"></i>`;
        }
    }

    const seriesText = book.series
        ? `${escapeHtml(book.series)}${book.series_index ? ` #${book.series_index}` : ''}`
        : '';
    const seriesInfo = book.series
        ? book.series_link_id
            ? `<div class="card-series"><a href="#/series/${book.series_link_id}" class="card-series-link">${seriesText}</a></div>`
            : `<div class="card-series">${seriesText}</div>`
        : '';

    const ownedClass = book.is_owned === 0 ? ' not-owned' : '';

    const progressBar = book.reading_status === 'reading' && book.progress
        ? `<div class="card-progress"><div class="card-progress-fill" style="width:${(book.progress * 100).toFixed(1)}%"></div></div>`
        : '';

    return `
        <div class="book-card card${ownedClass}" data-book-id="${book.id}" role="button">
            <div class="cover-container">
                ${coverImg}
                ${progressBar}
            </div>
            <div class="card-info">
                <div class="card-gutter ${gutterClass}">
                    ${gutterFav}
                    <div class="gutter-stars">${gutterStars}</div>
                </div>
                <div class="card-body">
                    <div class="card-title">${escapeHtml(book.title)}</div>
                    <div class="card-author">${authorsHtml(book.authors)}</div>
                    ${seriesInfo}
                </div>
            </div>
        </div>
    `;
}

function authorsHtml(authors: string): string {
    return authors.split(',').map(a => {
        const trimmed = a.trim();
        return `<span class="card-author-link" data-author="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</span>`;
    }).join(', ');
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
