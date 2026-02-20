import { api } from '../api';
import { getLibraryUsername, isOwner as isLibraryOwner } from '../context';
import { navigate } from '../router';
import { invalidateSeriesCache } from './series-list';

interface SeriesEntry {
    entry_id: number;
    position: number;
    hc_title: string;
    hc_author: string | null;
    entry_status: string;
    book_id: number | null;
    book_title: string | null;
    book_authors: string | null;
    book_cover_filename: string | null;
    book_cover_updated_at: string | null;
    book_user_id: number | null;
    book_reading_status: string | null;
    book_is_owned: number | null;
    book_rating: number | null;
    book_ignored: number;
}

export async function renderSeriesEdit(
    params: Record<string, string>
): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;
    const seriesId = parseInt(params.id);

    // Owner guard
    if (!isLibraryOwner()) {
        navigate(`/series/${seriesId}`);
        return;
    }

    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;

    try {
        const data = await api.getSeriesEdit(username, seriesId);
        if (!data.is_owner) {
            navigate(`/series/${seriesId}`);
            return;
        }
        renderEditPage(app, data, username, seriesId);
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load series: ${err.message}
            </div>
        `;
    }
}

function renderEditPage(
    app: HTMLElement,
    data: any,
    username: string,
    seriesId: number
): void {
    const entries: SeriesEntry[] = data.entries;
    const hasHcLink = !!data.hardcover_series_id;

    let html = `
        <div class="series-edit">
            <div class="d-flex align-items-center justify-content-between mb-3">
                <a href="#/series/${seriesId}" class="btn btn-outline-secondary btn-sm">
                    <i class="bi bi-arrow-left"></i> Back to Series
                </a>
                <h4 class="mb-0">Edit Series</h4>
            </div>

            <div class="mb-3">
                <label for="series-name" class="form-label">Series Name</label>
                <input type="text" class="form-control" id="series-name"
                       value="${escapeAttr(data.series_name)}">
            </div>

            <div class="d-flex gap-2 mb-3">
                ${hasHcLink ? `
                    <button class="btn btn-outline-info btn-sm" id="refresh-btn">
                        <i class="bi bi-arrow-repeat"></i> Refresh Series Data
                    </button>
                ` : ''}
                <button class="btn btn-primary btn-sm ms-auto" id="save-btn">
                    <i class="bi bi-check-lg"></i> Save Changes
                </button>
            </div>

            <div id="edit-alert"></div>

            <div class="table-responsive">
                <table class="table table-sm align-middle series-edit-table">
                    <thead>
                        <tr>
                            <th style="width: 70px">#</th>
                            <th>Your Library</th>
                            <th>Hardcover Reference</th>
                            <th style="width: 60px" class="text-center">Ignore</th>
                        </tr>
                    </thead>
                    <tbody id="entries-body">
    `;

    for (const entry of entries) {
        html += renderEntryRow(entry);
    }

    html += `
                    </tbody>
                </table>
            </div>
        </div>
    `;

    app.innerHTML = html;

    // Attach ignore checkbox handlers for dimming
    app.querySelectorAll('.ignore-check').forEach(cb => {
        cb.addEventListener('change', () => {
            const row = (cb as HTMLElement).closest('tr')!;
            if ((cb as HTMLInputElement).checked) {
                row.classList.add('series-entry-ignored');
            } else {
                row.classList.remove('series-entry-ignored');
            }
        });
    });

    // Refresh button
    if (hasHcLink) {
        document.getElementById('refresh-btn')!.addEventListener('click', async () => {
            const btn = document.getElementById('refresh-btn') as HTMLButtonElement;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Refreshing...';

            try {
                const result = await api.refreshSeries(username, seriesId);
                if (!result.changed) {
                    showAlert('No updates available from Hardcover.', 'info');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Refresh Series Data';
                } else {
                    invalidateSeriesCache();
                    // Re-render with fresh data
                    renderEditPage(app, result, username, seriesId);
                    showAlert('Series data updated from Hardcover.', 'success');
                }
            } catch (err: any) {
                showAlert(`Refresh failed: ${escapeHtml(err.message)}`, 'danger');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Refresh Series Data';
            }
        });
    }

    // Save button
    document.getElementById('save-btn')!.addEventListener('click', async () => {
        const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';

        try {
            const seriesName = (document.getElementById('series-name') as HTMLInputElement).value.trim();
            const entryUpdates: any[] = [];
            const bookIgnores: any[] = [];
            const seenEntryIds = new Set<number>();

            document.querySelectorAll('#entries-body tr').forEach(row => {
                const entryId = parseInt(row.getAttribute('data-entry-id')!);
                const bookId = row.getAttribute('data-book-id');
                const posInput = row.querySelector('.position-input') as HTMLInputElement;
                const ignoreCheck = row.querySelector('.ignore-check') as HTMLInputElement;

                const position = parseFloat(posInput.value) || 0;

                if (bookId) {
                    // Per-book ignore
                    bookIgnores.push({
                        book_id: parseInt(bookId),
                        ignored: ignoreCheck.checked,
                    });
                }

                // Entry updates (position + status for no-book entries)
                // Deduplicate by entry_id (multiple books at same position)
                if (!seenEntryIds.has(entryId)) {
                    seenEntryIds.add(entryId);
                    const status = (!bookId && ignoreCheck.checked)
                        ? 'ignored' : 'linked';
                    entryUpdates.push({
                        entry_id: entryId, position, status,
                    });
                }
            });

            await api.updateSeries(username, seriesId, {
                series_name: seriesName,
                entries: entryUpdates,
                book_ignores: bookIgnores,
            });

            invalidateSeriesCache();
            navigate(`/series/${seriesId}`);
        } catch (err: any) {
            showAlert(`Save failed: ${escapeHtml(err.message)}`, 'danger');
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> Save Changes';
        }
    });
}

function renderEntryRow(entry: SeriesEntry): string {
    // Per-book ignore when book exists, entry-level when no book
    const isIgnored = entry.book_id
        ? entry.book_ignored === 1
        : entry.entry_status === 'ignored';
    const ignoredClass = isIgnored ? ' series-entry-ignored' : '';

    // Book info (left column)
    let bookHtml: string;
    if (entry.book_id) {
        const coverImg = entry.book_cover_filename && entry.book_user_id
            ? `<img src="${api.coverUrl(entry.book_user_id, entry.book_cover_filename, entry.book_cover_updated_at)}"
                   style="width: 35px; height: 52px; object-fit: cover; border-radius: 3px;"
                   loading="lazy">`
            : `<div style="width: 35px; height: 52px; background: ${entry.book_is_owned === 0 ? '#fff3cd' : '#e9ecef'};
                   border-radius: 3px; display: flex; align-items: center; justify-content: center;">
                   <i class="bi bi-book text-muted" style="font-size: 0.8rem;"></i></div>`;

        const badge = statusBadge(
            entry.book_reading_status || 'unread',
            entry.book_is_owned ?? 1
        );

        bookHtml = `
            <div class="d-flex align-items-center gap-2">
                ${coverImg}
                <div class="min-width-0">
                    <div class="small fw-semibold text-truncate">${escapeHtml(entry.book_title || '')}</div>
                    <div class="small text-muted text-truncate">${escapeHtml(entry.book_authors || '')}</div>
                    <div>${badge}</div>
                </div>
            </div>
        `;
    } else {
        bookHtml = '<span class="text-muted small">No linked book</span>';
    }

    // HC reference (right column)
    const hcHtml = `
        <div class="small">
            <span class="text-muted">#${entry.position}</span>
            ${escapeHtml(entry.hc_title)}
        </div>
        <div class="small text-muted">${escapeHtml(entry.hc_author || '')}</div>
    `;

    const bookIdAttr = entry.book_id ? ` data-book-id="${entry.book_id}"` : '';

    return `
        <tr data-entry-id="${entry.entry_id}"${bookIdAttr} class="${ignoredClass}">
            <td>
                <input type="number" class="form-control form-control-sm position-input"
                       value="${entry.position}" step="0.1" style="width: 65px;">
            </td>
            <td>${bookHtml}</td>
            <td>${hcHtml}</td>
            <td class="text-center">
                <input type="checkbox" class="form-check-input ignore-check"
                       ${isIgnored ? 'checked' : ''}>
            </td>
        </tr>
    `;
}

function statusBadge(readingStatus: string, isOwned: number): string {
    const notOwned = isOwned === 0;
    if (notOwned && readingStatus === 'read') {
        return '<span class="badge bg-success-subtle text-success-emphasis" style="font-size: 0.65rem;">Read (not owned)</span>';
    } else if (notOwned) {
        return '<span class="badge bg-warning-subtle text-warning-emphasis" style="font-size: 0.65rem;">Not owned</span>';
    } else if (readingStatus === 'read') {
        return '<span class="badge bg-success" style="font-size: 0.65rem;">Read</span>';
    } else if (readingStatus === 'reading') {
        return '<span class="badge bg-primary" style="font-size: 0.65rem;">Reading</span>';
    }
    return '<span class="badge bg-secondary" style="font-size: 0.65rem;">Unread</span>';
}

function showAlert(message: string, type: string): void {
    const alertEl = document.getElementById('edit-alert');
    if (alertEl) {
        alertEl.innerHTML = `
            <div class="alert alert-${type} alert-dismissible fade show py-2" role="alert">
                ${message}
                <button type="button" class="btn-close btn-sm" data-bs-dismiss="alert"></button>
            </div>
        `;
    }
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
