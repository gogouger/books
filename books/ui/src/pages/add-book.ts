import { api } from '../api';
import { getLibraryUsername, isOwner } from '../context';
import { navigate, navigateHome } from '../router';
import {
    renderMetadataPicker,
    escapeHtml,
    SourceEntry,
} from '../components/metadata-picker';

export function renderAddBook(): void {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;

    if (!isOwner()) {
        navigateHome();
        return;
    }

    // Eagerly fetch series autocomplete for the metadata picker
    const seriesPromise = api.getSeriesAutocomplete(username)
        .then(data => data.series || [])
        .catch(() => []);

    app.innerHTML = `
        <div style="max-width: 700px; margin: 0 auto;">
            <h4 class="mb-3">Add Book</h4>

            <div class="card mb-3">
                <div class="card-body">
                    <h6>Upload EPUB</h6>
                    <div class="mb-3">
                        <input type="file" class="form-control" id="epub-file"
                               accept=".epub">
                    </div>
                    <p class="text-muted small mb-0">
                        Select an EPUB file to extract metadata and search online sources.
                    </p>
                </div>
            </div>

            <div class="text-center text-muted my-3">
                <span class="px-2">or</span>
            </div>

            <div class="card mb-3">
                <div class="card-body">
                    <h6>Search by Title</h6>
                    <div class="mb-2">
                        <input type="text" class="form-control" id="search-title"
                               placeholder="Title">
                    </div>
                    <div class="mb-3">
                        <input type="text" class="form-control" id="search-authors"
                               placeholder="Author (optional)">
                    </div>
                    <button class="btn btn-outline-primary" id="search-btn">
                        <i class="bi bi-search me-1"></i>Search
                    </button>
                    <p class="text-muted small mt-2 mb-0">
                        Add a book without an EPUB file. It will be marked as not owned.
                    </p>
                </div>
            </div>

            <div id="preview-area"></div>
            <div id="add-error" class="alert alert-danger d-none"></div>
        </div>
    `;

    const fileInput = document.getElementById('epub-file') as HTMLInputElement;

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;

        const previewArea = document.getElementById('preview-area')!;
        previewArea.innerHTML = `
            <div class="text-center py-5">
                <div class="spinner-border text-primary mb-3" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
                <p class="mb-0">Extracting metadata and searching online sources...</p>
            </div>
        `;

        try {
            const [data, seriesList] = await Promise.all([
                api.previewMetadata(username, file),
                seriesPromise,
            ]);
            showPreviewPicker(previewArea, data, file, username, fileInput, seriesList);
        } catch (err: any) {
            previewArea.innerHTML = '';
            showError(err.message);
        }
    });

    const searchBtn = document.getElementById('search-btn')!;
    const titleInput = document.getElementById('search-title') as HTMLInputElement;
    const authorsInput = document.getElementById('search-authors') as HTMLInputElement;

    const doSearch = async () => {
        const title = titleInput.value.trim();
        if (!title) return;
        const authors = authorsInput.value.trim();

        const previewArea = document.getElementById('preview-area')!;
        previewArea.innerHTML = `
            <div class="text-center py-5">
                <div class="spinner-border text-primary mb-3" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
                <p class="mb-0">Searching online sources...</p>
            </div>
        `;
        searchBtn.setAttribute('disabled', 'true');

        try {
            const [data, seriesList] = await Promise.all([
                api.searchAllMetadata(username, title, authors),
                seriesPromise,
            ]);
            searchBtn.removeAttribute('disabled');
            showManualPreviewPicker(previewArea, data, username, seriesList);
        } catch (err: any) {
            searchBtn.removeAttribute('disabled');
            previewArea.innerHTML = '';
            showError(err.message);
        }
    };

    searchBtn.addEventListener('click', doSearch);
    titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    authorsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
}

function showPreviewPicker(
    container: HTMLElement,
    data: any,
    file: File,
    username: string,
    fileInput: HTMLInputElement,
    seriesList: any[],
): void {
    // Build sources array
    const sources: SourceEntry[] = [
        { key: 'epub', label: 'EPUB', data: data.epub, error: null },
        { key: 'hardcover', label: 'Hardcover', data: data.hardcover, error: data.errors?.hardcover || null },
        { key: 'google', label: 'Google', data: data.google, error: data.errors?.google || null },
        { key: 'openlibrary', label: 'Open Library', data: data.openlibrary, error: data.errors?.openlibrary || null },
    ];

    // Wrap in a modal-like overlay
    const overlay = document.createElement('div');
    overlay.id = 'preview-modal';
    overlay.className = 'modal fade show d-block';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
    overlay.setAttribute('tabindex', '-1');
    document.body.appendChild(overlay);

    renderMetadataPicker(overlay, {
        sources,
        submitLabel: 'Add Book',
        seriesList,
        onApply: async (values, coverUrl) => {
            const payload: Record<string, any> = {
                temp_id: data.temp_id,
                title: values.title || data.epub?.title || file.name || 'Unknown',
                authors: values.authors || data.epub?.authors || 'Unknown',
            };
            if (values.series) payload.series = values.series;
            if (values.series_index) {
                payload.series_index = parseFloat(values.series_index);
            }
            if (values.description) payload.description = values.description;
            if (values.isbn) payload.isbn = values.isbn;
            if (values.published_date) payload.published_date = values.published_date;
            if (coverUrl) payload.cover_url = coverUrl;

            // Use raw fetch to handle 409 collision
            const resp = await api.addBookFromPreviewRaw(username, payload);

            if (resp.status === 409) {
                const conflict = await resp.json();
                overlay.remove();
                showCollisionDialog(
                    conflict.existing_book,
                    data.temp_id,
                    payload,
                    username,
                );
                return;
            }

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: resp.statusText }));
                throw new Error(err.detail || 'Failed to add book');
            }

            const result = await resp.json();
            overlay.remove();
            navigate(`#/book/${result.id}`);
        },
        onCancel: () => {
            overlay.remove();
            container.innerHTML = '';
            fileInput.value = '';
        },
    });
}

function showManualPreviewPicker(
    container: HTMLElement,
    data: any,
    username: string,
    seriesList: any[],
): void {
    const sources: SourceEntry[] = [
        { key: 'hardcover', label: 'Hardcover', data: data.hardcover, error: data.errors?.hardcover || null },
        { key: 'google', label: 'Google', data: data.google, error: data.errors?.google || null },
        { key: 'openlibrary', label: 'Open Library', data: data.openlibrary, error: data.errors?.openlibrary || null },
    ];

    const overlay = document.createElement('div');
    overlay.id = 'preview-modal';
    overlay.className = 'modal fade show d-block';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
    overlay.setAttribute('tabindex', '-1');
    document.body.appendChild(overlay);

    renderMetadataPicker(overlay, {
        sources,
        submitLabel: 'Add Book',
        seriesList,
        onApply: async (values, coverUrl) => {
            const payload: Record<string, any> = {
                temp_id: data.temp_id,
                title: values.title || 'Unknown',
                authors: values.authors || 'Unknown',
                manual: true,
            };
            if (values.series) payload.series = values.series;
            if (values.series_index) {
                payload.series_index = parseFloat(values.series_index);
            }
            if (values.description) payload.description = values.description;
            if (values.isbn) payload.isbn = values.isbn;
            if (values.published_date) payload.published_date = values.published_date;
            if (coverUrl) payload.cover_url = coverUrl;

            const resp = await api.addBookFromPreviewRaw(username, payload);

            if (resp.status === 409) {
                const conflict = await resp.json();
                overlay.remove();
                showCollisionDialog(
                    conflict.existing_book,
                    data.temp_id,
                    payload,
                    username,
                    true,
                );
                return;
            }

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: resp.statusText }));
                throw new Error(err.detail || 'Failed to add book');
            }

            const result = await resp.json();
            overlay.remove();
            navigate(`#/book/${result.id}`);
        },
        onCancel: () => {
            overlay.remove();
            container.innerHTML = '';
        },
    });
}

function showCollisionDialog(
    existing: any,
    tempId: string,
    payload: Record<string, any>,
    username: string,
    manual: boolean = false,
): void {
    document.getElementById('collision-modal')?.remove();

    const statusLabels: Record<string, string> = {
        unread: 'Unread',
        reading: 'Reading',
        read: 'Read',
    };
    const statusText = statusLabels[existing.reading_status] || existing.reading_status || 'Unread';
    const ratingText = existing.rating ? `${existing.rating}/5` : 'Not rated';
    const seriesText = existing.series
        ? `${escapeHtml(existing.series)}${existing.series_index ? ' #' + existing.series_index : ''}`
        : '';
    const coverHtml = existing.cover_filename
        ? `<img src="/covers/${existing.user_id}/${existing.cover_filename}"
               class="rounded me-3" style="width:60px; height:90px; object-fit:cover;">`
        : `<div class="rounded me-3 bg-secondary d-flex align-items-center justify-content-center"
               style="width:60px; height:90px; min-width:60px;">
               <i class="bi bi-book text-white"></i>
           </div>`;

    const overlay = document.createElement('div');
    overlay.id = 'collision-modal';
    overlay.className = 'modal fade show d-block';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
    overlay.setAttribute('tabindex', '-1');
    overlay.innerHTML = `
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Duplicate Book Detected</h5>
                    <button type="button" class="btn-close" id="collision-close"></button>
                </div>
                <div class="modal-body">
                    <p>A book with this title already exists in your library:</p>
                    <div class="d-flex align-items-start mb-3 p-2 border rounded">
                        ${coverHtml}
                        <div>
                            <strong>${escapeHtml(existing.title)}</strong>
                            <div class="small text-muted">${escapeHtml(existing.authors)}</div>
                            ${seriesText ? `<div class="small text-muted">${seriesText}</div>` : ''}
                            <div class="small mt-1">${statusText} &middot; ${ratingText}</div>
                        </div>
                    </div>
                    <p class="text-muted small mb-0">
                        <strong>Replace &amp; Merge</strong> updates the existing book with the new
                        ${manual ? 'metadata' : 'EPUB and metadata'}, keeping your rating and reading status.
                        <strong>Keep Both</strong> adds a second copy.
                    </p>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-outline-secondary" id="collision-cancel">Cancel</button>
                    <button type="button" class="btn btn-outline-primary" id="collision-keep">Keep Both</button>
                    <button type="button" class="btn btn-primary" id="collision-merge">Replace &amp; Merge</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    document.getElementById('collision-close')!.addEventListener('click', close);
    document.getElementById('collision-cancel')!.addEventListener('click', close);

    document.getElementById('collision-merge')!.addEventListener('click', async () => {
        const mergeBtn = document.getElementById('collision-merge')!;
        mergeBtn.setAttribute('disabled', 'true');
        mergeBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Merging...';
        try {
            const result = await api.addBookFromPreview(username, {
                ...payload,
                merge_with: existing.id,
            });
            overlay.remove();
            navigate(`#/book/${result.id}`);
        } catch (err: any) {
            overlay.remove();
            showError(err.message);
        }
    });

    document.getElementById('collision-keep')!.addEventListener('click', async () => {
        const keepBtn = document.getElementById('collision-keep')!;
        keepBtn.setAttribute('disabled', 'true');
        keepBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Adding...';
        try {
            const result = await api.addBookFromPreview(username, {
                ...payload,
                force: true,
            });
            overlay.remove();
            navigate(`#/book/${result.id}`);
        } catch (err: any) {
            overlay.remove();
            showError(err.message);
        }
    });
}

function showError(message: string): void {
    const el = document.getElementById('add-error');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('d-none');
    setTimeout(() => el.classList.add('d-none'), 5000);
}
