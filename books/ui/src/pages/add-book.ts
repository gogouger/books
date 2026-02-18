import { api } from '../api';
import { getToken } from '../auth';
import { getLibraryUsername, isOwner } from '../context';
import { navigate, navigateHome } from '../router';

export function renderAddBook(): void {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;

    if (!isOwner()) {
        navigateHome();
        return;
    }

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
                    <button class="btn btn-outline-secondary btn-sm" id="extract-btn" disabled>
                        Extract Metadata
                    </button>
                </div>
            </div>

            <div class="card mb-3">
                <div class="card-body">
                    <h6>Metadata Search</h6>
                    <div class="input-group mb-3">
                        <input type="text" class="form-control" id="meta-query"
                               placeholder="Search by title, author, or ISBN...">
                        <button class="btn btn-outline-primary" id="meta-search-btn">
                            Search
                        </button>
                    </div>
                    <div id="meta-results"></div>
                </div>
            </div>

            <div class="card mb-3">
                <div class="card-body">
                    <h6>Book Details</h6>
                    <form id="add-form">
                        <div class="mb-2">
                            <label class="form-label">Title</label>
                            <input type="text" class="form-control" id="add-title" required>
                        </div>
                        <div class="mb-2">
                            <label class="form-label">Authors</label>
                            <input type="text" class="form-control" id="add-authors">
                        </div>
                        <div class="row mb-2">
                            <div class="col-8">
                                <label class="form-label">Series</label>
                                <input type="text" class="form-control" id="add-series">
                            </div>
                            <div class="col-4">
                                <label class="form-label">Series #</label>
                                <input type="number" class="form-control" id="add-series-index"
                                       step="0.1">
                            </div>
                        </div>
                        <div class="mb-2">
                            <label class="form-label">Description</label>
                            <textarea class="form-control" id="add-description" rows="3"></textarea>
                        </div>
                        <div id="add-error" class="alert alert-danger d-none"></div>
                        <button type="submit" class="btn btn-primary" id="add-submit">
                            Add Book
                        </button>
                    </form>
                </div>
            </div>
        </div>
    `;

    const fileInput = document.getElementById('epub-file') as HTMLInputElement;
    const extractBtn = document.getElementById('extract-btn')!;

    fileInput.addEventListener('change', () => {
        extractBtn.removeAttribute('disabled');
    });

    extractBtn.addEventListener('click', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;

        extractBtn.setAttribute('disabled', 'true');
        extractBtn.textContent = 'Extracting...';
        try {
            const formData = new FormData();
            formData.append('file', file);
            const token = getToken();
            const headers: Record<string, string> = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const resp = await fetch(`/api/${username}/metadata/extract`, {
                method: 'POST',
                headers,
                body: formData,
            });
            if (!resp.ok) throw new Error('Extraction failed');
            const meta = await resp.json();
            fillForm(meta);
        } catch (err: any) {
            showError(err.message);
        } finally {
            extractBtn.removeAttribute('disabled');
            extractBtn.textContent = 'Extract Metadata';
        }
    });

    document.getElementById('meta-search-btn')!.addEventListener('click', async () => {
        const query = (document.getElementById('meta-query') as HTMLInputElement).value;
        if (!query) return;

        const resultsDiv = document.getElementById('meta-results')!;
        resultsDiv.innerHTML = '<div class="spinner-border spinner-border-sm"></div>';

        try {
            const data = await api.searchMetadata(username, query);
            if (!data.results.length) {
                resultsDiv.innerHTML = '<p class="text-muted">No results found</p>';
                return;
            }

            resultsDiv.innerHTML = data.results.map((r: any, i: number) => `
                <div class="border rounded p-2 mb-2 meta-result" role="button"
                     data-index="${i}">
                    <strong>${escapeHtml(r.title)}</strong>
                    <div class="small text-muted">${escapeHtml(r.authors)}</div>
                    ${r.isbn ? `<div class="small">ISBN: ${r.isbn}</div>` : ''}
                </div>
            `).join('');

            resultsDiv.querySelectorAll('.meta-result').forEach(el => {
                el.addEventListener('click', () => {
                    const idx = parseInt(el.getAttribute('data-index')!);
                    fillForm(data.results[idx]);
                });
            });
        } catch (err: any) {
            resultsDiv.innerHTML = `<p class="text-danger">${err.message}</p>`;
        }
    });

    document.getElementById('add-form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const file = fileInput.files?.[0];
        if (!file) {
            showError('Please select an EPUB file');
            return;
        }

        const submitBtn = document.getElementById('add-submit')!;
        submitBtn.setAttribute('disabled', 'true');
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Adding...';

        try {
            const metadata: Record<string, any> = {};
            const title = (document.getElementById('add-title') as HTMLInputElement).value;
            const authors = (document.getElementById('add-authors') as HTMLInputElement).value;
            const series = (document.getElementById('add-series') as HTMLInputElement).value;
            const seriesIndex = (document.getElementById('add-series-index') as HTMLInputElement).value;

            if (title) metadata.title = title;
            if (authors) metadata.authors = authors;
            if (series) metadata.series = series;
            if (seriesIndex) metadata.series_index = parseFloat(seriesIndex);

            const book = await api.uploadBook(username, file, metadata);
            navigate(`#/book/${book.id}`);
        } catch (err: any) {
            showError(err.message);
        } finally {
            submitBtn.removeAttribute('disabled');
            submitBtn.textContent = 'Add Book';
        }
    });
}

function fillForm(meta: any): void {
    if (meta.title) {
        (document.getElementById('add-title') as HTMLInputElement).value = meta.title;
    }
    if (meta.authors) {
        (document.getElementById('add-authors') as HTMLInputElement).value = meta.authors;
    }
    if (meta.description) {
        (document.getElementById('add-description') as HTMLTextAreaElement).value =
            meta.description.replace(/<[^>]*>/g, '');
    }
}

function showError(message: string): void {
    const el = document.getElementById('add-error')!;
    el.textContent = message;
    el.classList.remove('d-none');
    setTimeout(() => el.classList.add('d-none'), 5000);
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
