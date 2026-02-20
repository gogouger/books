import { api } from '../api';
import { getUser } from '../auth';
import { getLibraryUsername } from '../context';
import { navigate, navigateHome } from '../router';
import { setAuthorFilter, updateCachedBook, invalidateLibraryCache } from './library';
import { invalidateSeriesCache } from './series-list';
import {
    ratingStarsHtml,
    attachRatingHandler,
    favoriteButtonHtml,
    attachFavoriteHandler,
} from '../components/rating-stars';
import {
    renderMetadataPicker,
    escapeHtml,
    escapeAttr,
    SourceEntry,
} from '../components/metadata-picker';

export async function renderBookDetail(
    params: Record<string, string>,
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

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'of', 'and', 'in', 'to', 'for',
    'on', 'at', 'by', 'with', 'from', 'or', 'is', 'it', 'as',
]);

function buildCalibreSearchUrl(title: string, authors: string): string {
    // Extract last name of first author, dropping suffixes
    const suffixes = new Set([
        'jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md',
    ]);
    const firstAuthor = authors.split(/,|&| and /)[0].trim();
    const nameParts = firstAuthor.split(/\s+/).filter(
        w => !suffixes.has(w.replace(/\./g, '').toLowerCase())
    );
    const authorLastName = nameParts[nameParts.length - 1].toLowerCase();

    // Extract title keywords
    const mainTitle = title.split(/:|\ - /)[0].trim();
    const rawWords = mainTitle.split(/[\s-]+/).map(
        w => w.replace(/[^\w]/g, '')
    );
    let keywords = rawWords.filter(w => {
        if (!w) return false;
        const lw = w.toLowerCase();
        if (STOP_WORDS.has(lw)) return false;
        if (/^[ivxlc]+$/i.test(w)) return false;
        if (/^\d+$/.test(w)) return false;
        return true;
    });
    if (keywords.length === 0) {
        // Fallback: original words minus articles and empty strings
        const articles = new Set(['the', 'a', 'an']);
        keywords = rawWords.filter(
            w => w && !articles.has(w.toLowerCase())
        );
    }
    const titlePattern = '%' + keywords.map(
        w => w.toLowerCase()
    ).join('%') + '%';

    const sql = `select cover, title, authors, year, series, language, links, formats from summary where language = "eng" and instr(links,'epub') and not instr(authors,'calibre') and instr(lower(authors),'${authorLastName}') and lower(title) like '${titlePattern}'`;

    return `http://85.10.194.198:5001/index?sql=${encodeURIComponent(sql)}`;
}

function buildKeywordSearch(title: string, authors: string): string {
    const suffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md']);
    const firstAuthor = authors.split(/,|&| and /)[0].trim();
    const nameParts = firstAuthor.split(/\s+/).filter(
        w => !suffixes.has(w.replace(/\./g, '').toLowerCase())
    );
    const authorLastName = nameParts[nameParts.length - 1];

    const mainTitle = title.split(/:|\ - /)[0].trim();
    const rawWords = mainTitle.split(/[\s-]+/).map(
        w => w.replace(/[^\w]/g, '')
    );
    let keywords = rawWords.filter(w => {
        if (!w) return false;
        const lw = w.toLowerCase();
        if (STOP_WORDS.has(lw)) return false;
        if (/^[ivxlc]+$/i.test(w)) return false;
        if (/^\d+$/.test(w)) return false;
        return true;
    });
    if (keywords.length === 0) {
        const articles = new Set(['the', 'a', 'an']);
        keywords = rawWords.filter(
            w => w && !articles.has(w.toLowerCase())
        );
    }

    return [...keywords, authorLastName].join(' ');
}

function renderBook(app: HTMLElement, book: any, username: string): void {
    const isOwner: boolean = book.is_owner;

    const coverHtml = book.cover_filename
        ? `<img src="${api.coverUrl(book.user_id, book.cover_filename, book.cover_updated_at)}"
               alt="${escapeHtml(book.title)}" class="cover-large">`
        : `<div class="no-cover-large"><i class="bi bi-book"></i></div>`;

    const seriesHtml = book.series && book.series_link_id
        ? `<div class="text-muted mb-2">
               <a href="#/series/${book.series_link_id}">${escapeHtml(book.series)}</a>${book.series_index ? ` #${book.series_index}` : ''}
           </div>`
        : book.series
            ? `<div class="text-muted mb-2">
                   ${escapeHtml(book.series)}${book.series_index ? ` #${book.series_index}` : ''}
               </div>`
            : '';

    const publishedHtml = book.published_date
        ? `<div class="text-muted mb-2 small">Published: ${escapeHtml(book.published_date)}</div>`
        : '';

    // Rating: editable for owner, static for viewer
    const ratingHtml = ratingStarsHtml(book.rating, isOwner);

    // Favorite: toggle for owner, static for viewer
    const favoriteHtml = favoriteButtonHtml(!!book.is_favorite, isOwner);

    // Status: 3-button group for owner, text label for viewer
    const statusLabel = book.reading_status === 'read' ? 'Read'
        : book.reading_status === 'reading' ? 'Reading' : 'Unread';
    const disabledAttr = isOwner ? '' : ' disabled';
    const statusHtml = `<div class="d-flex gap-2" id="status-buttons">
               <button type="button" class="btn btn-sm flex-fill ${book.reading_status === 'unread' ? 'btn-secondary' : 'btn-outline-secondary'}" data-status="unread"${disabledAttr}>Unread</button>
               <button type="button" class="btn btn-sm flex-fill ${book.reading_status === 'reading' ? 'btn-primary' : 'btn-outline-primary'}" data-status="reading"${disabledAttr}>Reading</button>
               <button type="button" class="btn btn-sm flex-fill ${book.reading_status === 'read' ? 'btn-success' : 'btn-outline-success'}" data-status="read"${disabledAttr}>Read</button>
           </div>`;

    // Date finished
    const finishedVal = book.date_finished ? book.date_finished.split('T')[0] : '';
    const dateHtml = isOwner
        ? `<div class="d-flex align-items-center gap-2">
               <label class="form-label mb-0 text-muted small">Finished</label>
               <input type="date" class="form-control form-control-sm" id="date-finished" value="${finishedVal}">
           </div>`
        : finishedVal
            ? `<span class="text-muted small">Finished ${formatDate(book.date_finished)}</span>`
            : '';

    // Search links: keyword-based for stores/library, SQL-based for Calibre
    const keywords = encodeURIComponent(buildKeywordSearch(book.title, book.authors));
    const calibreUrl = buildCalibreSearchUrl(book.title, book.authors);
    const userLibraries = getUser()?.libraries ?? [];
    const libraryLinks = userLibraries.map(
        (lib: any) => `<a href="https://${lib.url}/search?query=${keywords}" target="_blank" rel="noopener" class="btn btn-outline-secondary btn-sm flex-fill">${escapeHtml(lib.name)}</a>`
    ).join('\n               ');
    const calibreLink = isOwner
        ? `<a href="${calibreUrl}" target="_blank" rel="noopener" class="btn btn-outline-secondary btn-sm flex-fill">Web</a>`
        : '';
    const ownerOnlyLinks = [libraryLinks, calibreLink].filter(Boolean).join('\n               ');
    const searchLinksHtml = `<div class="d-flex gap-2 align-items-center">
               <i class="bi bi-search text-muted"></i>
               <a href="https://www.amazon.com/s?k=${keywords}&i=digital-text" target="_blank" rel="noopener" class="btn btn-outline-secondary btn-sm flex-fill">Kindle</a>
               <a href="https://www.kobo.com/search?query=${keywords}" target="_blank" rel="noopener" class="btn btn-outline-secondary btn-sm flex-fill">Kobo</a>
               ${ownerOnlyLinks}
           </div>`;

    // "Not in library" indicator for unowned books
    const notOwnedHtml = book.is_owned === 0
        ? '<span class="badge bg-secondary ms-2">Not in library</span>'
        : '';

    // Action buttons
    const kindleEmail = book.kindle_email || '';
    const currentUser = getUser();
    let actionsHtml = '';
    if (isOwner) {
        const kindleAttr = kindleEmail
            ? `title="Send to ${escapeAttr(kindleEmail)}"`
            : 'disabled title="Set your Kindle email in settings first"';
        const fileButtons = book.file_path && book.is_owned !== 0
            ? `<button class="btn btn-outline-primary btn-sm flex-fill" id="download-btn">
                   <i class="bi bi-download"></i> EPUB
               </button>
               <button class="btn btn-outline-warning btn-sm flex-fill" id="kindle-btn"
                   ${kindleAttr}>
                   <i class="bi bi-send"></i> Kindle
               </button>`
            : '';
        actionsHtml = `<div class="d-flex gap-2">
               <a href="#/book/${book.id}/edit" class="btn btn-outline-secondary btn-sm flex-fill" id="edit-btn">
                   <i class="bi bi-pencil"></i> Edit
               </a>
               <button class="btn btn-outline-info btn-sm flex-fill" id="refresh-meta-btn">
                   <i class="bi bi-arrow-repeat"></i> Meta
               </button>
               ${fileButtons}
           </div>`;
    } else if (currentUser && book.is_owned !== 0) {
        actionsHtml = `<div class="d-flex gap-2">
               <button class="btn btn-outline-success btn-sm" id="copy-to-library-btn">
                   <i class="bi bi-plus-circle"></i> Copy to My Library
               </button>
           </div>`;
    }

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
                    <h2>${escapeHtml(book.title)}${notOwnedHtml}</h2>
                    <h5 class="text-muted"><a href="#" class="author-link">${escapeHtml(book.authors)}</a></h5>
                    ${seriesHtml}
                    ${publishedHtml}

                    <div class="detail-panel">
                        <div class="detail-rating-row mb-3">
                            <span id="rating-container">${ratingHtml}</span>
                            <span id="favorite-container">${favoriteHtml}</span>
                        </div>

                        <div class="mb-3">${statusHtml}</div>

                        ${dateHtml ? `<div class="mb-3">${dateHtml}</div>` : ''}

                        ${actionsHtml ? `<div class="mb-3">${actionsHtml}</div>` : ''}
                        <div class="mb-0">${searchLinksHtml}</div>

                        <div id="action-alert" class="mt-2"></div>
                    </div>

                </div>
            </div>

            ${book.description ? `
                <div class="mt-4">
                    <h5>Description</h5>
                    <div class="card card-body bg-body-tertiary">
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

    const authorLink = app.querySelector('.author-link');
    if (authorLink) {
        authorLink.addEventListener('click', (e) => {
            e.preventDefault();
            setAuthorFilter(book.authors);
            navigateHome();
        });
    }

    // Copy to My Library handler (non-owner only)
    const copyBtn = document.getElementById('copy-to-library-btn');
    if (copyBtn && currentUser) {
        copyBtn.addEventListener('click', async () => {
            copyBtn.setAttribute('disabled', 'true');
            copyBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Loading...';
            try {
                const [data, seriesList] = await Promise.all([
                    api.copyToTemp(username, book.id),
                    api.getSeriesAutocomplete(currentUser.username)
                        .then(r => r.series || [])
                        .catch(() => []),
                ]);
                showCopyPicker(data, currentUser.username, username, seriesList);
            } catch (err: any) {
                showAlert(err.message, 'danger');
                copyBtn.removeAttribute('disabled');
                copyBtn.innerHTML = '<i class="bi bi-plus-circle"></i> Copy to My Library';
            }
        });
    }

    // Only attach edit handlers if owner
    if (!isOwner) return;

    attachRatingHandler(
        document.getElementById('rating-container')!,
        async (rating) => {
            try {
                await api.updateBook(username, book.id, { rating: rating || null });
                updateCachedBook(book.id, { rating: rating || null });
                invalidateSeriesCache();
                showAlert('Rating updated', 'success');
            } catch (err: any) {
                showAlert(err.message, 'danger');
            }
        }
    );

    attachFavoriteHandler(
        document.getElementById('favorite-container')!,
        async (isFavorite) => {
            try {
                await api.updateBook(username, book.id, { is_favorite: isFavorite });
                book.is_favorite = isFavorite;
                updateCachedBook(book.id, { is_favorite: isFavorite });
                showAlert('Favorite updated', 'success');
            } catch (err: any) {
                showAlert(err.message, 'danger');
            }
        }
    );

    const statusButtons = document.getElementById('status-buttons')!;
    statusButtons.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', async () => {
            const newStatus = btn.dataset.status!;
            const updates: Record<string, any> = { reading_status: newStatus };
            const today = new Date().toISOString().split('T')[0];

            if (newStatus === 'read' && !book.date_finished) {
                updates.date_finished = today;
                const finishedInput = document.getElementById('date-finished') as HTMLInputElement;
                if (finishedInput) finishedInput.value = today;
            }

            try {
                await api.updateBook(username, book.id, updates);
                // Update button styles
                statusButtons.querySelectorAll('button').forEach(b => {
                    const s = b.dataset.status!;
                    const active = s === newStatus;
                    b.className = 'btn btn-sm flex-fill ' + (
                        s === 'unread' ? (active ? 'btn-secondary' : 'btn-outline-secondary') :
                        s === 'reading' ? (active ? 'btn-primary' : 'btn-outline-primary') :
                        (active ? 'btn-success' : 'btn-outline-success')
                    );
                });
                book.reading_status = newStatus;
                if (updates.date_finished) book.date_finished = updates.date_finished;
                updateCachedBook(book.id, updates);
                invalidateSeriesCache();
                showAlert('Status updated', 'success');
            } catch (err: any) {
                showAlert(err.message, 'danger');
            }
        });
    });

    const dateFinished = document.getElementById('date-finished') as HTMLInputElement;
    if (dateFinished) dateFinished.addEventListener('change', async () => {
        try {
            const updates: Record<string, any> = {
                date_finished: dateFinished.value || null,
            };
            // Setting a finished date implies "read"
            if (dateFinished.value && book.reading_status !== 'read') {
                updates.reading_status = 'read';
            }
            await api.updateBook(username, book.id, updates);
            updateCachedBook(book.id, updates);
            invalidateSeriesCache();
            if (updates.reading_status) {
                book.reading_status = 'read';
                const statusBtns = document.getElementById('status-buttons');
                if (statusBtns) statusBtns.querySelectorAll('button').forEach(b => {
                    const s = (b as HTMLButtonElement).dataset.status!;
                    const active = s === 'read';
                    b.className = 'btn btn-sm flex-fill ' + (
                        s === 'unread' ? (active ? 'btn-secondary' : 'btn-outline-secondary') :
                        s === 'reading' ? (active ? 'btn-primary' : 'btn-outline-primary') :
                        (active ? 'btn-success' : 'btn-outline-success')
                    );
                });
            }
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

    const refreshMetaBtn = document.getElementById('refresh-meta-btn');
    if (refreshMetaBtn) {
        refreshMetaBtn.addEventListener('click', () => {
            showRefreshModal(book, username);
        });
    }

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


async function showRefreshModal(book: any, username: string): Promise<void> {
    document.getElementById('refresh-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'refresh-modal';
    overlay.className = 'modal fade show d-block';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
    overlay.setAttribute('tabindex', '-1');
    overlay.innerHTML = `
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-body text-center py-5">
                    <div class="spinner-border text-primary mb-3" role="status">
                        <span class="visually-hidden">Loading...</span>
                    </div>
                    <p class="mb-0">Searching Google Books, Hardcover, and Open Library...</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    try {
        const [data, seriesList] = await Promise.all([
            api.refreshMetadata(username, book.id),
            api.getSeriesAutocomplete(username)
                .then(r => r.series || [])
                .catch(() => []),
        ]);
        const errors = data.errors || {};

        const sources: SourceEntry[] = [
            { key: 'current', label: 'Current', data: data.current, error: null },
        ];
        if (data.epub) {
            sources.push({ key: 'epub', label: 'EPUB', data: data.epub, error: null });
        }
        sources.push(
            { key: 'hardcover', label: 'Hardcover', data: data.hardcover, error: errors['hardcover'] || null },
            { key: 'google', label: 'Google', data: data.google, error: errors['google'] || null },
            { key: 'openlibrary', label: 'Open Library', data: data.openlibrary, error: errors['openlibrary'] || null },
        );

        renderMetadataPicker(overlay, {
            sources,
            submitLabel: 'Apply Selected',
            seriesList,
            onApply: async (values, coverUrl) => {
                const updates: Record<string, any> = {};
                for (const [k, v] of Object.entries(values)) {
                    if (k === 'series_index') {
                        const parsed = parseFloat(v);
                        updates[k] = isNaN(parsed) ? null : parsed;
                    } else {
                        updates[k] = v;
                    }
                }

                if (Object.keys(updates).length > 0) {
                    await api.updateBook(username, book.id, updates);
                }

                if (coverUrl && !coverUrl.startsWith('/covers/')) {
                    await api.setCoverFromUrl(username, book.id, coverUrl);
                }

                invalidateLibraryCache();
                invalidateSeriesCache();
                overlay.remove();
                renderBookDetail({ id: String(book.id) });
            },
            onCancel: () => overlay.remove(),
        });
    } catch (err: any) {
        overlay.innerHTML = `
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Refresh Metadata</h5>
                        <button type="button" class="btn-close" id="modal-close-err"></button>
                    </div>
                    <div class="modal-body">
                        <div class="alert alert-danger mb-0">
                            Failed to fetch metadata: ${escapeHtml(err.message)}
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('modal-close-err')!.addEventListener('click', () => {
            overlay.remove();
        });
    }
}


async function showCopyPicker(
    data: any,
    myUsername: string,
    sourceUsername: string,
    seriesList: any[],
): Promise<void> {
    const errors = data.errors || {};

    const sources: SourceEntry[] = [];
    if (data.current) {
        sources.push({
            key: 'current', label: 'Source',
            data: data.current, error: null,
        });
    }
    if (data.epub) {
        sources.push({
            key: 'epub', label: 'EPUB',
            data: data.epub, error: null,
        });
    }
    sources.push(
        {
            key: 'hardcover', label: 'Hardcover',
            data: data.hardcover,
            error: errors['hardcover'] || null,
        },
        {
            key: 'google', label: 'Google',
            data: data.google,
            error: errors['google'] || null,
        },
        {
            key: 'openlibrary', label: 'Open Library',
            data: data.openlibrary,
            error: errors['openlibrary'] || null,
        },
    );

    const overlay = document.createElement('div');
    overlay.id = 'copy-modal';
    overlay.className = 'modal fade show d-block';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
    overlay.setAttribute('tabindex', '-1');
    document.body.appendChild(overlay);

    renderMetadataPicker(overlay, {
        sources,
        submitLabel: 'Add to My Library',
        seriesList,
        onApply: async (values, coverUrl) => {
            const payload: Record<string, any> = {
                temp_id: data.temp_id,
                title: values.title || 'Unknown',
                authors: values.authors || 'Unknown',
            };
            if (values.series) payload.series = values.series;
            if (values.series_index) {
                payload.series_index = parseFloat(
                    values.series_index
                );
            }
            if (values.description) {
                payload.description = values.description;
            }
            if (values.isbn) payload.isbn = values.isbn;
            if (values.published_date) {
                payload.published_date = values.published_date;
            }
            if (coverUrl) payload.cover_url = coverUrl;

            const resp = await api.addBookFromPreviewRaw(
                myUsername, payload
            );

            if (resp.status === 409) {
                overlay.remove();
                showAlert(
                    'A matching book already exists'
                    + ' in your library',
                    'warning',
                );
                return;
            }

            if (!resp.ok) {
                const err = await resp.json().catch(
                    () => ({ detail: resp.statusText })
                );
                throw new Error(
                    err.detail || 'Failed to add book'
                );
            }

            const result = await resp.json();
            overlay.remove();
            window.location.href = (
                `/${myUsername}/#/book/${result.id}`
            );
        },
        onCancel: () => overlay.remove(),
    });
}
