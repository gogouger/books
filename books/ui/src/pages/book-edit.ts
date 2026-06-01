import { api } from '../api';
import { setupSeriesPicker, SeriesInfo } from '../components/series-picker';
import { getLibraryUsername, isOwner as isLibraryOwner } from '../context';
import { navigate, navigateHome } from '../router';
import { invalidateLibraryCache } from './library';
import { invalidateSeriesCache } from './series-list';
import {
    ratingStarsHtml,
    attachRatingHandler,
    favoriteButtonHtml,
    attachFavoriteHandler,
} from '../components/rating-stars';

export async function renderBookEdit(
    params: Record<string, string>
): Promise<void> {
    const app = document.getElementById('app')!;
    const bookId = parseInt(params.id);
    const username = getLibraryUsername()!;

    // Owner guard (includes superuser check)
    if (!isLibraryOwner()) {
        navigate(`/book/${bookId}`);
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
        const [book, seriesAc] = await Promise.all([
            api.getBook(username, bookId),
            api.getSeriesAutocomplete(username),
        ]);

        if (!book.is_owner) {
            navigate(`/book/${bookId}`);
            return;
        }

        renderForm(app, book, seriesAc.series || [], username);
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load book: ${err.message}
            </div>
        `;
    }
}

function renderForm(
    app: HTMLElement,
    book: any,
    seriesList: SeriesInfo[],
    username: string
): void {
    const finishedVal = book.date_finished
        ? book.date_finished.split('T')[0]
        : '';

    const ratingHtml = ratingStarsHtml(book.rating, true);
    const favoriteHtml = favoriteButtonHtml(!!book.is_favorite, true);

    app.innerHTML = `
        <div class="book-detail">
            <div class="d-flex align-items-center mb-3">
                <a href="#/book/${book.id}" class="btn btn-outline-secondary btn-sm">
                    <i class="bi bi-arrow-left"></i> Back to Book
                </a>
                <h4 class="mb-0 ms-3">Edit Book</h4>
            </div>

            <form id="edit-form">
                <div class="mb-3">
                    <label for="edit-title" class="form-label">Title</label>
                    <input type="text" class="form-control" id="edit-title"
                           value="${escapeAttr(book.title)}" required>
                </div>

                <div class="mb-3">
                    <label for="edit-authors" class="form-label">Authors</label>
                    <input type="text" class="form-control" id="edit-authors"
                           value="${escapeAttr(book.authors)}" required>
                </div>

                <div class="row mb-3">
                    <div class="col">
                        <label for="edit-series" class="form-label">Series</label>
                        <input type="text" class="form-control" id="edit-series"
                               value="${escapeAttr(book.series || '')}">
                    </div>
                    <div class="col-auto" style="width: 120px">
                        <label for="edit-series-index" class="form-label">Series #</label>
                        <input type="number" class="form-control" id="edit-series-index"
                               step="0.1" value="${book.series_index ?? ''}">
                    </div>
                </div>
                <div id="series-numbers" class="mb-3" style="margin-top: -0.75rem"></div>

                <div class="row mb-3">
                    <div class="col">
                        <label for="edit-isbn" class="form-label">ISBN</label>
                        <input type="text" class="form-control" id="edit-isbn"
                               value="${escapeAttr(book.isbn || '')}">
                    </div>
                    <div class="col">
                        <label for="edit-published-date" class="form-label">Published Date</label>
                        <input type="text" class="form-control" id="edit-published-date"
                               placeholder="e.g. 2024-03-15"
                               value="${escapeAttr(book.published_date || '')}">
                    </div>
                </div>

                <div class="mb-3">
                    <label class="form-label">Rating & Favorite</label>
                    <div class="detail-rating-row">
                        <span id="rating-container">${ratingHtml}</span>
                        <span id="favorite-container">${favoriteHtml}</span>
                    </div>
                </div>

                <div class="mb-3">
                    <label class="form-label">Read Status</label>
                    <div class="d-flex gap-2" id="status-buttons">
                        <button type="button" class="btn btn-sm flex-fill ${book.reading_status === 'unread' ? 'btn-secondary' : 'btn-outline-secondary'}" data-status="unread">Unread</button>
                        <button type="button" class="btn btn-sm flex-fill ${book.reading_status === 'reading' ? 'btn-primary' : 'btn-outline-primary'}" data-status="reading">Reading</button>
                        <button type="button" class="btn btn-sm flex-fill ${book.reading_status === 'read' ? 'btn-success' : 'btn-outline-success'}" data-status="read">Read</button>
                    </div>
                </div>

                <div class="mb-3">
                    <label for="edit-date-finished" class="form-label">Finished Date</label>
                    <input type="date" class="form-control" id="edit-date-finished"
                           value="${finishedVal}">
                </div>

                <div class="mb-3">
                    <label for="edit-manual-category" class="form-label">Category</label>
                    <select class="form-select" id="edit-manual-category">
                        <option value=""${book.manual_category ? '' : ' selected'}>Auto (let the heuristic decide)</option>
                        <option value="Fiction"${book.manual_category === 'Fiction' ? ' selected' : ''}>Fiction</option>
                        <option value="Religious"${book.manual_category === 'Religious' ? ' selected' : ''}>Religious</option>
                    </select>
                </div>

                <div class="mb-3">
                    <label for="edit-description" class="form-label">Description</label>
                    <textarea class="form-control" id="edit-description"
                              rows="5">${escapeHtml(book.description || '')}</textarea>
                </div>

                <div class="d-flex gap-2">
                    <button type="submit" class="btn btn-primary" id="save-btn">
                        <i class="bi bi-check-lg"></i> Save
                    </button>
                    <a href="#/book/${book.id}" class="btn btn-outline-secondary">Cancel</a>
                </div>

                <div id="edit-alert" class="mt-2"></div>
            </form>

            <hr class="mt-4">
            <div class="mb-3">
                <button type="button" class="btn btn-outline-danger btn-sm" id="delete-btn">
                    <i class="bi bi-trash"></i> Delete Book
                </button>
            </div>
        </div>

        <div class="modal fade" id="delete-confirm-modal" tabindex="-1">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Delete Book</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <p>Are you sure you want to delete <strong>${escapeHtml(book.title)}</strong>?</p>
                        <p class="text-muted small mb-0">The book will be moved to the archive.</p>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
                        <button type="button" class="btn btn-danger" id="confirm-delete-btn">
                            <i class="bi bi-trash"></i> Delete
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Set up series autocomplete
    setupSeriesPicker({
        input: document.getElementById('edit-series') as HTMLInputElement,
        seriesList,
        getAuthor: () =>
            (document.getElementById('edit-authors') as HTMLInputElement).value,
        numbersContainer: document.getElementById('series-numbers')!,
    });

    // Track local state for rating/favorite/status
    let currentRating = book.rating;
    let currentFavorite = !!book.is_favorite;
    let currentStatus = book.reading_status;

    attachRatingHandler(
        document.getElementById('rating-container')!,
        (rating) => { currentRating = rating || null; }
    );

    attachFavoriteHandler(
        document.getElementById('favorite-container')!,
        (isFavorite) => { currentFavorite = isFavorite; }
    );

    // Status button toggling (local only)
    const statusButtons = document.getElementById('status-buttons')!;
    statusButtons.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            currentStatus = btn.dataset.status!;
            statusButtons.querySelectorAll('button').forEach(b => {
                const s = (b as HTMLButtonElement).dataset.status!;
                const active = s === currentStatus;
                b.className = 'btn btn-sm flex-fill ' + (
                    s === 'unread' ? (active ? 'btn-secondary' : 'btn-outline-secondary') :
                    s === 'reading' ? (active ? 'btn-primary' : 'btn-outline-primary') :
                    (active ? 'btn-success' : 'btn-outline-success')
                );
            });
        });
    });

    // Save handler
    const form = document.getElementById('edit-form') as HTMLFormElement;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const title = (document.getElementById('edit-title') as HTMLInputElement).value.trim();
        const authors = (document.getElementById('edit-authors') as HTMLInputElement).value.trim();
        const series = (document.getElementById('edit-series') as HTMLInputElement).value.trim() || null;
        const seriesIndexStr = (document.getElementById('edit-series-index') as HTMLInputElement).value;
        const seriesIndex = seriesIndexStr ? parseFloat(seriesIndexStr) : null;
        const isbn = (document.getElementById('edit-isbn') as HTMLInputElement).value.trim() || null;
        const publishedDate = (document.getElementById('edit-published-date') as HTMLInputElement).value.trim() || null;
        const dateFinished = (document.getElementById('edit-date-finished') as HTMLInputElement).value || null;
        const description = (document.getElementById('edit-description') as HTMLTextAreaElement).value.trim() || null;
        const manualCategory = (document.getElementById('edit-manual-category') as HTMLSelectElement).value || null;

        const updates: Record<string, any> = {
            title,
            authors,
            series,
            series_index: seriesIndex,
            isbn,
            published_date: publishedDate,
            date_finished: dateFinished,
            description,
            rating: currentRating,
            is_favorite: currentFavorite,
            reading_status: currentStatus,
            manual_category: manualCategory,
        };

        const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';

        try {
            await api.updateBook(username, book.id, updates);
            invalidateLibraryCache();
            invalidateSeriesCache();
            navigate(`/book/${book.id}`);
        } catch (err: any) {
            const alertEl = document.getElementById('edit-alert')!;
            alertEl.innerHTML = `
                <div class="alert alert-danger alert-dismissible fade show py-2" role="alert">
                    ${escapeHtml(err.message)}
                    <button type="button" class="btn-close btn-sm" data-bs-dismiss="alert"></button>
                </div>
            `;
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> Save';
        }
    });

    // Delete button handler
    const deleteBtn = document.getElementById('delete-btn');
    const modalEl = document.getElementById('delete-confirm-modal');
    if (deleteBtn && modalEl) {
        deleteBtn.addEventListener('click', () => {
            const modal = new (window as any).bootstrap.Modal(modalEl);
            modal.show();
        });

        const confirmBtn = document.getElementById('confirm-delete-btn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', async () => {
                confirmBtn.setAttribute('disabled', 'true');
                confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting...';
                try {
                    await api.deleteBook(username, book.id);
                    invalidateLibraryCache();
                    invalidateSeriesCache();
                    const modal = (window as any).bootstrap.Modal.getInstance(modalEl);
                    modal?.hide();
                    navigateHome();
                } catch (err: any) {
                    const alertEl = document.getElementById('edit-alert')!;
                    alertEl.innerHTML = `
                        <div class="alert alert-danger alert-dismissible fade show py-2" role="alert">
                            ${escapeHtml(err.message)}
                            <button type="button" class="btn-close btn-sm" data-bs-dismiss="alert"></button>
                        </div>
                    `;
                    confirmBtn.removeAttribute('disabled');
                    confirmBtn.innerHTML = '<i class="bi bi-trash"></i> Delete';
                    const modal = (window as any).bootstrap.Modal.getInstance(modalEl);
                    modal?.hide();
                }
            });
        }
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
