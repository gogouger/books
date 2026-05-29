import { api } from '../api';
import { getUser } from '../auth';
import { getLibraryUsername } from '../context';
import { navigateHome } from '../router';
import { bookGridHtml, attachGridClickHandlers } from '../components/book-grid';
import { invalidateSeriesCache } from './series-list';
import { setAuthorFilter } from './library';

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
        const books: any[] = data.books;

        // Sort by hc_position (Hardcover canonical) or series_index
        books.sort((a, b) => {
            const posA = a.hc_position ?? a.series_index ?? 0;
            const posB = b.hc_position ?? b.series_index ?? 0;
            return posA - posB;
        });

        const readCount = books.filter(b => b.reading_status === 'read').length;
        const notOwnedCount = books.filter(b => b.is_owned === 0).length;
        const notOwnedLabel = notOwnedCount > 0
            ? ` &middot; <span class="text-danger">${notOwnedCount} not owned</span>`
            : '';

        const segmentsHtml = renderSegmentedBar(books);
        const isOwner: boolean = data.is_owner;
        const monitored: boolean = data.monitored !== false;
        const seriesComplete: boolean = data.series_complete !== false;

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

        const completeBtn = isOwner
            ? `<button class="btn btn-outline-${seriesComplete ? 'warning' : 'success'} btn-sm ms-2" id="complete-toggle"
                       title="${seriesComplete ? 'Mark series as still being written' : 'Mark series as finished by the author'}">
                   <i class="bi bi-${seriesComplete ? 'hourglass-split' : 'check-circle'}"></i>
                   ${seriesComplete ? 'Mark Ongoing' : 'Mark Complete'}
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

        const grLink = `<a href="https://www.google.com/search?q=${encodeURIComponent(seriesName + ' site:goodreads.com/series')}" target="_blank" rel="noopener"
              class="btn btn-outline-secondary btn-sm ms-2"
              title="Search Goodreads series via Google">
                   <i class="bi bi-box-arrow-up-right"></i> Goodreads
               </a>`;

        let html = `
            <div class="d-flex align-items-center flex-wrap gap-1 mb-3">
                <a href="#/series" class="btn btn-outline-secondary btn-sm">
                    <i class="bi bi-arrow-left"></i> All Series
                </a>
                ${editBtn}
                ${monitorBtn}
                ${completeBtn}
                ${copySeriesBtn}
                ${hcLink}
                ${grLink}
            </div>
            <h4 class="mb-3">${escapeHtml(seriesName)}</h4>
            <div class="text-muted mb-2">
                ${books.length} book${books.length !== 1 ? 's' : ''}
                &middot; ${readCount}/${books.length} read${notOwnedLabel}
            </div>
            <div class="mb-3">${segmentsHtml}</div>
        `;

        html += `<div class="mb-4">${bookGridHtml(books)}</div>`;

        app.innerHTML = html;

        attachGridClickHandlers(app, (author) => {
            setAuthorFilter(author);
            navigateHome();
        });

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

        const completeToggle = app.querySelector('#complete-toggle');
        if (completeToggle) {
            completeToggle.addEventListener('click', async () => {
                const newComplete = !seriesComplete;
                try {
                    await api.updateSeries(username, seriesId, {
                        series_complete: newComplete,
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

const STATUS_CLASS: Record<string, string> = {
    read: 'segment-read', reading: 'segment-reading',
};

function renderSegmentedBar(books: any[]): string {
    const segments = books.map(b => {
        const cls = STATUS_CLASS[b.reading_status] || 'segment-unread';
        const owned = b.is_owned !== 0 ? '' : ' segment-not-owned';
        const prog = b.progress || 0;
        if (b.reading_status === 'reading') {
            const pct = Math.round(prog * 100);
            return `<div class="series-segment${owned}" style="border-color:var(--bs-primary);background:linear-gradient(to right,var(--bs-primary) ${pct}%,var(--bs-secondary-bg) ${pct}%)"></div>`;
        }
        return `<div class="series-segment ${cls}${owned}"></div>`;
    });
    return `<div class="series-segments">${segments.join('')}</div>`;
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
