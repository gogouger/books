import { api } from '../api';
import { getUser } from '../auth';
import { getLibraryUsername } from '../context';
import { ratingStarsHtml } from '../components/rating-stars';
import { invalidateSeriesCache } from './series-list';

interface SeriesBook {
    id: number;
    title: string;
    authors: string;
    cover_filename: string | null;
    cover_updated_at: string | null;
    user_id: number;
    series_index: number | null;
    hc_position: number | null;
    reading_status: string;
    rating: number | null;
    is_favorite: boolean;
    is_owned: number;
    published_date: string | null;
}

export async function renderSeriesView(
    params: Record<string, string>
): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;
    const seriesId = parseInt(params.id);

    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;

    try {
        const data = await api.getSeriesBooks(username, seriesId);
        const seriesName: string = data.series;
        const hardcoverUrl: string | null = data.hardcover_url;
        const books: SeriesBook[] = data.books;

        // Sort by hc_position (Hardcover canonical) or series_index
        books.sort((a, b) => {
            const posA = a.hc_position ?? a.series_index ?? 0;
            const posB = b.hc_position ?? b.series_index ?? 0;
            return posA - posB;
        });

        const readCount = books.filter(b => b.reading_status === 'read').length;
        const readingCount = books.filter(b => b.reading_status === 'reading').length;
        const notOwnedCount = books.filter(b => b.is_owned === 0).length;
        const notOwnedLabel = notOwnedCount > 0
            ? ` &middot; <span class="text-danger">${notOwnedCount} not owned</span>`
            : '';

        const segmentsHtml = renderSegmentedBar(books);
        const isOwner: boolean = data.is_owner;
        const monitored: boolean = data.monitored !== false;

        const editBtn = isOwner
            ? `<a href="#/series/${seriesId}/edit" class="btn btn-outline-primary btn-sm ms-2">
                   <i class="bi bi-pencil"></i> Edit Series
               </a>`
            : '';

        const monitorBtn = isOwner
            ? `<button class="btn btn-outline-${monitored ? 'warning' : 'success'} btn-sm ms-2" id="monitor-toggle"
                       title="${monitored ? 'Hide this series from the list' : 'Show this series in the list'}">
                   <i class="bi bi-${monitored ? 'eye-slash' : 'eye'}"></i>
                   ${monitored ? 'Hide' : 'Unhide'}
               </button>`
            : '';

        const currentUser = getUser();
        const copySeriesBtn = (!isOwner && currentUser)
            ? `<button class="btn btn-outline-success btn-sm ms-2" id="copy-series-btn">
                   <i class="bi bi-collection"></i> Copy Series
               </button>`
            : '';

        const hcLink = hardcoverUrl
            ? `<a href="${hardcoverUrl}" target="_blank" rel="noopener"
                  class="btn btn-outline-secondary btn-sm ms-2"
                  title="View on Hardcover">
                   <i class="bi bi-box-arrow-up-right"></i> Hardcover
               </a>`
            : '';

        let html = `
            <div class="d-flex align-items-center mb-3">
                <a href="#/series" class="btn btn-outline-secondary btn-sm">
                    <i class="bi bi-arrow-left"></i> All Series
                </a>
                ${editBtn}
                ${monitorBtn}
                ${copySeriesBtn}
                ${hcLink}
            </div>
            <h4 class="mb-3">${escapeHtml(seriesName)}</h4>
            <div class="text-muted mb-2">
                ${books.length} book${books.length !== 1 ? 's' : ''}
                &middot; ${readCount}/${books.length} read${notOwnedLabel}
            </div>
            <div class="mb-3">${segmentsHtml}</div>
        `;

        html += '<div class="list-group mb-4">';
        for (const book of books) {
            html += renderSeriesBook(book);
        }
        html += '</div>';

        app.innerHTML = html;

        const monitorToggle = app.querySelector('#monitor-toggle');
        if (monitorToggle) {
            monitorToggle.addEventListener('click', async () => {
                const newMonitored = !monitored;
                try {
                    await api.updateSeries(username, seriesId, {
                        monitored: newMonitored,
                    });
                    invalidateSeriesCache();
                    renderSeriesView(params);
                } catch (e: any) {
                    alert(`Failed to update: ${e.message}`);
                }
            });
        }

        const copySeriesEl = app.querySelector('#copy-series-btn');
        if (copySeriesEl && currentUser) {
            copySeriesEl.addEventListener('click', async () => {
                const ownedCount = books.filter(b => b.is_owned !== 0).length;
                const ok = confirm(
                    `Copy ${ownedCount} owned book(s) from "${seriesName}" to your library?\n\nBooks you already have will be skipped.`
                );
                if (!ok) return;

                const btn = copySeriesEl as HTMLButtonElement;
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Copying...';
                try {
                    const result = await api.copySeriesFromLibrary(username, seriesId);
                    alert(`Copied ${result.copied} book(s), skipped ${result.skipped}.`);
                    window.location.href = `/${currentUser.username}/#/series`;
                } catch (e: any) {
                    alert(`Failed to copy: ${e.message}`);
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-collection"></i> Copy Series';
                }
            });
        }
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load series: ${err.message}
            </div>
        `;
    }
}

function renderSeriesBook(book: SeriesBook): string {
    const coverImg = book.cover_filename
        ? `<img src="${api.coverUrl(book.user_id, book.cover_filename, book.cover_updated_at)}"
               style="width: 50px; height: 75px; object-fit: cover; border-radius: 4px;"
               loading="lazy">`
        : `<div style="width: 50px; height: 75px; background: ${book.is_owned === 0 ? '#fff3cd' : '#e9ecef'}; border-radius: 4px;
               display: flex; align-items: center; justify-content: center;">
               <i class="bi bi-book text-muted"></i></div>`;

    const notOwned = book.is_owned === 0;
    const statusClass = book.reading_status === 'read'
        ? 'series-book-read'
        : book.reading_status === 'reading'
            ? 'series-book-reading'
            : notOwned
                ? 'series-book-not-owned-unread'
                : '';
    const ownedClass = notOwned ? ' series-book-not-owned' : '';

    let badge: string;
    if (notOwned && book.reading_status === 'read') {
        badge = '<span class="badge bg-success-subtle text-success-emphasis">Read (not owned)</span>';
    } else if (notOwned) {
        badge = '<span class="badge bg-warning-subtle text-warning-emphasis">Not owned</span>';
    } else if (book.reading_status === 'read') {
        badge = '<span class="badge bg-success">Read</span>';
    } else if (book.reading_status === 'reading') {
        badge = '<span class="badge bg-primary">Reading</span>';
    } else {
        badge = '<span class="badge bg-secondary">Unread</span>';
    }

    const ratingLine = book.rating
        ? `<div class="mt-1">${ratingStarsHtml(book.rating)}${book.is_favorite ? ' <i class="bi bi-heart-fill" style="color: #dc3545; font-size: 0.8rem;"></i>' : ''}</div>`
        : (book.is_favorite ? '<div class="mt-1"><i class="bi bi-heart-fill" style="color: #dc3545; font-size: 0.8rem;"></i></div>' : '');

    const position = book.hc_position ?? book.series_index;

    const pubDate = formatShortDate(book.published_date);
    const authorLine = pubDate
        ? `${escapeHtml(book.authors)} (${pubDate})`
        : escapeHtml(book.authors);

    return `
        <a href="#/book/${book.id}"
           class="list-group-item list-group-item-action d-flex align-items-start gap-3 ${statusClass}${ownedClass}">
            ${coverImg}
            <div class="flex-grow-1">
                <div class="d-flex justify-content-between">
                    <div>
                        <span class="text-muted me-2">#${position || '?'}</span>
                        <strong>${escapeHtml(book.title)}</strong>
                    </div>
                    <div>${badge}</div>
                </div>
                <div class="small text-muted">${authorLine}</div>
                ${ratingLine}
            </div>
        </a>
    `;
}

const STATUS_CLASS: Record<string, string> = {
    read: 'segment-read', reading: 'segment-reading',
};

function renderSegmentedBar(books: SeriesBook[]): string {
    const segments = books.map(b => {
        const cls = STATUS_CLASS[b.reading_status] || 'segment-unread';
        const owned = b.is_owned !== 0 ? '' : ' segment-not-owned';
        return `<div class="series-segment ${cls}${owned}"></div>`;
    });
    return `<div class="series-segments">${segments.join('')}</div>`;
}

function formatShortDate(dateStr: string | null): string {
    if (!dateStr) return '';
    // dateStr is typically "YYYY-MM-DD" or ISO
    const parts = dateStr.split('T')[0].split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[1]}-${parts[2]}-${parts[0]}`;
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
