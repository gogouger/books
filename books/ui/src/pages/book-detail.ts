import { api } from '../api';
import { getLibraryUsername } from '../context';
import { navigate, navigateHome } from '../router';
import { ratingStarsHtml, attachRatingHandler } from '../components/rating-stars';

export async function renderBookDetail(
    params: Record<string, string>
): Promise<void> {
    const app = document.getElementById('app')!;
    const bookId = parseInt(params.id);
    const username = getLibraryUsername()!;

    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;

    try {
        const book = await api.getBook(username, bookId);
        renderBook(app, book, username);
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load book: ${err.message}
            </div>
        `;
    }
}

function renderBook(app: HTMLElement, book: any, username: string): void {
    const isOwner: boolean = book.is_owner;

    const coverHtml = book.cover_filename
        ? `<img src="${api.coverUrl(book.user_id, book.cover_filename)}"
               alt="${escapeHtml(book.title)}" class="cover-large">`
        : `<div class="no-cover-large"><i class="bi bi-book"></i></div>`;

    const tagsHtml = (book.tags || [])
        .map((t: string) => `<span class="badge bg-secondary tag-badge">${escapeHtml(t)}</span>`)
        .join('');

    const seriesLink = book.series
        ? `<a href="#/series/${encodeURIComponent(book.series)}">${escapeHtml(book.series)}</a>${book.series_index ? ` #${book.series_index}` : ''}`
        : '<span class="text-muted">-</span>';

    // Rating: editable for owner, static for viewer
    const ratingHtml = ratingStarsHtml(book.rating, isOwner);

    // Status: toggle for owner, plain text for viewer
    const statusHtml = isOwner
        ? `<div class="form-check form-switch">
               <input class="form-check-input" type="checkbox"
                      id="read-toggle" ${book.is_read ? 'checked' : ''}>
               <label class="form-check-label" for="read-toggle">
                   ${book.is_read ? 'Read' : 'Unread'}
               </label>
           </div>`
        : `<span>${book.is_read ? 'Read' : 'Unread'}</span>`;

    // Date finished: input for owner, text for viewer
    const dateVal = book.date_finished ? book.date_finished.split('T')[0] : '';
    const dateHtml = isOwner
        ? `<input type="date" class="form-control form-control-sm"
                  id="date-finished" style="width: 200px;"
                  value="${dateVal}">`
        : `<span>${dateVal ? formatDate(book.date_finished) : '<span class="text-muted">-</span>'}</span>`;

    // Action buttons: only for owner
    const actionsHtml = isOwner
        ? `<div class="mt-3 d-flex gap-2 flex-wrap">
               ${book.file_path ? `
                   <button class="btn btn-outline-primary btn-sm" id="download-btn">
                       <i class="bi bi-download"></i> Download EPUB
                   </button>
                   <button class="btn btn-outline-warning btn-sm" id="kindle-btn">
                       <i class="bi bi-send"></i> Send to Kindle
                   </button>
               ` : ''}
               <button class="btn btn-outline-danger btn-sm" id="delete-btn">
                   <i class="bi bi-trash"></i> Delete
               </button>
           </div>`
        : '';

    app.innerHTML = `
        <div class="book-detail">
            <a href="#" class="btn btn-outline-secondary btn-sm mb-3" id="back-to-library">
                <i class="bi bi-arrow-left"></i> Back to Library
            </a>

            <div class="row">
                <div class="col-auto">
                    ${coverHtml}
                </div>
                <div class="col">
                    <h2>${escapeHtml(book.title)}</h2>
                    <h5 class="text-muted">${escapeHtml(book.authors)}</h5>

                    <table class="table metadata-table mt-3">
                        <tbody>
                            <tr>
                                <th>Rating</th>
                                <td id="rating-container">
                                    ${ratingHtml}
                                </td>
                            </tr>
                            <tr>
                                <th>Status</th>
                                <td>${statusHtml}</td>
                            </tr>
                            <tr>
                                <th>Date Finished</th>
                                <td>${dateHtml}</td>
                            </tr>
                            <tr>
                                <th>Series</th>
                                <td>${seriesLink}</td>
                            </tr>
                            <tr>
                                <th>ISBN</th>
                                <td>${book.isbn || '<span class="text-muted">-</span>'}</td>
                            </tr>
                            <tr>
                                <th>Goodreads</th>
                                <td>${book.goodreads_id
                                    ? `<a href="https://www.goodreads.com/book/show/${book.goodreads_id}" target="_blank" rel="noopener">${book.goodreads_id}</a>`
                                    : '<span class="text-muted">-</span>'}</td>
                            </tr>
                            <tr>
                                <th>Tags</th>
                                <td>${tagsHtml || '<span class="text-muted">-</span>'}</td>
                            </tr>
                            <tr>
                                <th>Added</th>
                                <td>${formatDate(book.date_added)}</td>
                            </tr>
                        </tbody>
                    </table>

                    ${actionsHtml}

                    <div id="action-alert" class="mt-2"></div>
                </div>
            </div>

            ${book.description ? `
                <div class="mt-4">
                    <h5>Description</h5>
                    <div class="card card-body bg-white">
                        ${book.description}
                    </div>
                </div>
            ` : ''}
        </div>
    `;

    document.getElementById('back-to-library')!.addEventListener('click', (e) => {
        e.preventDefault();
        navigateHome();
    });

    // Only attach edit handlers if owner
    if (!isOwner) return;

    attachRatingHandler(
        document.getElementById('rating-container')!,
        async (rating) => {
            try {
                await api.updateBook(username, book.id, { rating });
                showAlert('Rating updated', 'success');
            } catch (err: any) {
                showAlert(err.message, 'danger');
            }
        }
    );

    const readToggle = document.getElementById('read-toggle') as HTMLInputElement;
    readToggle.addEventListener('change', async () => {
        const isRead = readToggle.checked ? 1 : 0;
        const label = readToggle.nextElementSibling!;
        label.textContent = isRead ? 'Read' : 'Unread';
        try {
            const updates: Record<string, any> = { is_read: isRead };
            if (isRead && !book.date_finished) {
                const today = new Date().toISOString().split('T')[0];
                updates.date_finished = today;
                (document.getElementById('date-finished') as HTMLInputElement).value = today;
            }
            await api.updateBook(username, book.id, updates);
            showAlert('Status updated', 'success');
        } catch (err: any) {
            showAlert(err.message, 'danger');
        }
    });

    const dateFinished = document.getElementById('date-finished') as HTMLInputElement;
    dateFinished.addEventListener('change', async () => {
        try {
            await api.updateBook(username, book.id, {
                date_finished: dateFinished.value || null,
            });
            showAlert('Date updated', 'success');
        } catch (err: any) {
            showAlert(err.message, 'danger');
        }
    });

    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', async () => {
            downloadBtn.setAttribute('disabled', 'true');
            downloadBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Downloading...';
            try {
                await api.downloadFile(username, book.id, book.title);
            } catch (err: any) {
                showAlert(err.message, 'danger');
            } finally {
                downloadBtn.removeAttribute('disabled');
                downloadBtn.innerHTML = '<i class="bi bi-download"></i> Download EPUB';
            }
        });
    }

    const kindleBtn = document.getElementById('kindle-btn');
    if (kindleBtn) {
        kindleBtn.addEventListener('click', async () => {
            kindleBtn.setAttribute('disabled', 'true');
            kindleBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Sending...';
            try {
                const result = await api.sendToKindle(username, book.id);
                showAlert(`Sent to ${result.sent_to}`, 'success');
            } catch (err: any) {
                showAlert(err.message, 'danger');
            } finally {
                kindleBtn.removeAttribute('disabled');
                kindleBtn.innerHTML = '<i class="bi bi-send"></i> Send to Kindle';
            }
        });
    }

    const deleteBtn = document.getElementById('delete-btn')!;
    deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return;
        try {
            await api.deleteBook(username, book.id);
            navigateHome();
        } catch (err: any) {
            showAlert(err.message, 'danger');
        }
    });
}

function showAlert(message: string, type: string): void {
    const container = document.getElementById('action-alert')!;
    container.innerHTML = `
        <div class="alert alert-${type} alert-dismissible fade show py-2" role="alert">
            ${escapeHtml(message)}
            <button type="button" class="btn-close btn-sm" data-bs-dismiss="alert"></button>
        </div>
    `;
    setTimeout(() => { container.innerHTML = ''; }, 3000);
}

function formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    try {
        return new Date(dateStr).toLocaleDateString();
    } catch {
        return dateStr;
    }
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
