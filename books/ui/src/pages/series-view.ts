import { api } from '../api';
import { getLibraryUsername } from '../context';
import { ratingStarsHtml } from '../components/rating-stars';

export async function renderSeriesView(
    params: Record<string, string>
): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;
    const seriesName = params.name;

    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;

    try {
        const data = await api.getSeriesBooks(username, seriesName);
        const books: any[] = data.books;

        // Find first unread
        const firstUnreadIdx = books.findIndex(b => !b.is_read);

        let html = `
            <a href="#/series" class="btn btn-outline-secondary btn-sm mb-3">
                <i class="bi bi-arrow-left"></i> All Series
            </a>
            <h4 class="mb-3">${escapeHtml(seriesName)}</h4>
            <div class="text-muted mb-3">
                ${books.length} book${books.length !== 1 ? 's' : ''}
                &middot; ${books.filter(b => b.is_read).length} read
            </div>
        `;

        html += '<div class="list-group">';
        for (let i = 0; i < books.length; i++) {
            const book = books[i];
            const isNextUnread = i === firstUnreadIdx;
            const coverImg = book.cover_filename
                ? `<img src="${api.coverUrl(book.user_id, book.cover_filename)}"
                       style="width: 50px; height: 75px; object-fit: cover; border-radius: 4px;"
                       loading="lazy">`
                : `<div style="width: 50px; height: 75px; background: #e9ecef; border-radius: 4px;
                       display: flex; align-items: center; justify-content: center;">
                       <i class="bi bi-book text-muted"></i></div>`;

            html += `
                <a href="#/book/${book.id}"
                   class="list-group-item list-group-item-action d-flex align-items-center gap-3
                          ${isNextUnread ? 'next-unread' : ''}">
                    ${coverImg}
                    <div class="flex-grow-1">
                        <div class="d-flex justify-content-between">
                            <div>
                                <span class="text-muted me-2">#${book.series_index || '?'}</span>
                                <strong>${escapeHtml(book.title)}</strong>
                            </div>
                            <div>
                                ${book.is_read
                                    ? '<span class="badge bg-success">Read</span>'
                                    : isNextUnread
                                        ? '<span class="badge bg-primary">Next</span>'
                                        : '<span class="badge bg-secondary">Unread</span>'}
                            </div>
                        </div>
                        <div class="small text-muted">${escapeHtml(book.authors)}</div>
                        ${book.rating ? `<div class="mt-1">${ratingStarsHtml(book.rating)}</div>` : ''}
                    </div>
                </a>
            `;
        }
        html += '</div>';

        app.innerHTML = html;
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load series: ${err.message}
            </div>
        `;
    }
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
