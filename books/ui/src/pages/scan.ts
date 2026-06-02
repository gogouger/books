/* Scan / Add-by-ISBN page.
 *
 * Phase 1: ISBN-paste UX — type or paste an ISBN, hit Enter, the book
 * gets looked up (Google Books → Open Library fallback) and added to
 * the library with the sticky category + format. Recent additions land
 * at the top of an in-page feed with a 1-click undo.
 *
 * Phase 2 (TODO): native BarcodeDetector camera viewfinder layered on top.
 */

import { api } from '../api';
import { getLibraryUsername, isOwner } from '../context';
import { navigateHome } from '../router';
import { invalidateLibraryCache } from './library';

type AddedBook = {
    id: number;
    title: string;
    authors: string;
    isbn: string;
    category: 'Religious' | 'Fiction';
    format: string;
    timestamp: number;
};

const RECENT_MAX = 20;
const recentlyAdded: AddedBook[] = [];

function getStickyCategory(): 'Religious' | 'Fiction' {
    const stored = localStorage.getItem('scan_category');
    return stored === 'Fiction' ? 'Fiction' : 'Religious';
}

function setStickyCategory(cat: 'Religious' | 'Fiction'): void {
    localStorage.setItem('scan_category', cat);
}

function getStickyFormat(): string {
    return localStorage.getItem('scan_format') || 'physical';
}

function setStickyFormat(fmt: string): void {
    localStorage.setItem('scan_format', fmt);
}

function normalizeIsbn(s: string): string {
    // Strip hyphens, spaces. ISBN-10/13 acceptable.
    return s.replace(/[-\s]/g, '').trim();
}

function isValidIsbn(s: string): boolean {
    const n = normalizeIsbn(s);
    return /^[0-9]{10}$|^[0-9]{13}$|^[0-9]{9}X$/i.test(n);
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#39;',
    }[c]!));
}

function renderRecentRow(b: AddedBook): string {
    const when = new Date(b.timestamp).toLocaleTimeString();
    return `
        <li class="list-group-item d-flex justify-content-between align-items-start scan-row">
          <div>
            <div class="fw-medium">${escapeHtml(b.title)}</div>
            <div class="text-muted small">${escapeHtml(b.authors)} · ISBN ${escapeHtml(b.isbn)}</div>
            <div class="small">
              <span class="badge bg-secondary-subtle text-secondary-emphasis me-1">${b.category}</span>
              <span class="badge bg-secondary-subtle text-secondary-emphasis">${b.format}</span>
              <span class="text-muted ms-2">${when}</span>
            </div>
          </div>
          <button class="btn btn-sm btn-outline-danger scan-undo" data-book-id="${b.id}" title="Undo this add">
            <i class="bi bi-x-lg"></i>
          </button>
        </li>`;
}

function refreshRecentList(): void {
    const ul = document.getElementById('scan-recent') as HTMLUListElement | null;
    if (!ul) return;
    ul.innerHTML = recentlyAdded.length
        ? recentlyAdded.map(renderRecentRow).join('')
        : '<li class="list-group-item text-muted small text-center py-3">No books added yet — scan or paste an ISBN above to begin.</li>';
    ul.querySelectorAll<HTMLButtonElement>('.scan-undo').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const bookId = Number(btn.dataset.bookId);
            const username = getLibraryUsername()!;
            btn.disabled = true;
            try {
                await api.deleteBook(username, bookId);
                const idx = recentlyAdded.findIndex(b => b.id === bookId);
                if (idx >= 0) recentlyAdded.splice(idx, 1);
                refreshRecentList();
                invalidateLibraryCache();
                setStatus('Removed.', 'info');
            } catch (e: any) {
                btn.disabled = false;
                setStatus(e?.message || 'Undo failed', 'error');
            }
        });
    });
}

function setStatus(msg: string, kind: 'info' | 'error' | 'busy' = 'info'): void {
    const el = document.getElementById('scan-status');
    if (!el) return;
    el.textContent = msg;
    el.className =
        'small mt-2 mb-0 ' +
        (kind === 'error' ? 'text-danger' :
         kind === 'busy' ? 'text-muted' : 'text-success');
}

async function lookupAndAdd(rawIsbn: string): Promise<void> {
    const isbn = normalizeIsbn(rawIsbn);
    if (!isValidIsbn(isbn)) {
        setStatus(`"${rawIsbn}" doesn't look like a valid ISBN.`, 'error');
        return;
    }
    const username = getLibraryUsername()!;
    const category = getStickyCategory();
    const format = getStickyFormat();
    setStatus(`Looking up ${isbn}…`, 'busy');

    // 1) Try Google Books with isbn: prefix, then plain ISBN, then Open Library
    let result: any = null;
    for (const [source, query] of [
        ['google', `isbn:${isbn}`],
        ['google', isbn],
        ['openlibrary', isbn],
    ] as const) {
        try {
            const resp = await api.searchMetadata(username, query, source);
            const hits = resp?.results || [];
            if (hits.length) { result = hits[0]; break; }
        } catch { /* try next source */ }
    }
    if (!result) {
        setStatus(`No metadata found for ISBN ${isbn}. Add it manually from the Add Book page.`, 'error');
        return;
    }

    // 2) Build a BookFromPreview-shaped body with manual=true (no file)
    const body = {
        temp_id: crypto.randomUUID(),
        manual: true,
        title: result.title || `ISBN ${isbn}`,
        authors: result.authors || result.author || 'Unknown',
        series: result.series || null,
        series_index: result.series_index ?? null,
        description: result.description || null,
        isbn: isbn,
        published_date: result.published_date || null,
        tags: result.tags || null,
        cover_url: result.cover_url || result.thumbnail || null,
        is_owned: true,
        book_format: format,
        reading_status: 'unread',
        manual_category: category,
    };

    setStatus(`Adding "${body.title}"…`, 'busy');
    try {
        const created = await api.addBookFromPreview(username, body);
        const newId = created?.id ?? created?.book_id;
        if (!newId) throw new Error('Server did not return a book id');

        recentlyAdded.unshift({
            id: newId, title: body.title, authors: body.authors,
            isbn, category, format, timestamp: Date.now(),
        });
        if (recentlyAdded.length > RECENT_MAX) recentlyAdded.pop();
        refreshRecentList();
        invalidateLibraryCache();
        setStatus(`Added: ${body.title}`, 'info');
        // Clear the input + refocus for the next scan
        const inp = document.getElementById('scan-isbn') as HTMLInputElement | null;
        if (inp) { inp.value = ''; inp.focus(); }
    } catch (e: any) {
        setStatus(e?.message || 'Add failed', 'error');
    }
}

export function renderScanBooks(): void {
    const app = document.getElementById('app')!;
    if (!isOwner()) { navigateHome(); return; }

    const cat = getStickyCategory();
    const fmt = getStickyFormat();

    app.innerHTML = `
      <div style="max-width: 640px; margin: 0 auto;">
        <h4 class="mb-1">Scan / Add by ISBN</h4>
        <p class="text-muted small mb-3">
          Paste or type an ISBN-10 or ISBN-13 (with or without dashes).
          The book gets looked up and added to your library with the
          category + format below. A camera barcode scanner is on the way.
        </p>

        <div class="card mb-3">
          <div class="card-body">
            <div class="row g-2 align-items-end mb-3">
              <div class="col-sm-6">
                <label class="form-label small text-muted mb-1">Category</label>
                <select class="form-select" id="scan-category">
                  <option value="Religious" ${cat === 'Religious' ? 'selected' : ''}>Religious</option>
                  <option value="Fiction"   ${cat === 'Fiction'   ? 'selected' : ''}>Fiction</option>
                </select>
              </div>
              <div class="col-sm-6">
                <label class="form-label small text-muted mb-1">Format</label>
                <select class="form-select" id="scan-format">
                  <option value="physical"  ${fmt === 'physical'  ? 'selected' : ''}>Physical</option>
                  <option value="audiobook" ${fmt === 'audiobook' ? 'selected' : ''}>Audiobook</option>
                  <option value="ebook"     ${fmt === 'ebook'     ? 'selected' : ''}>Ebook</option>
                </select>
              </div>
            </div>

            <label for="scan-isbn" class="form-label small text-muted mb-1">ISBN</label>
            <div class="input-group">
              <input type="text" class="form-control" id="scan-isbn"
                     inputmode="numeric" autocomplete="off"
                     placeholder="9780743260909" autofocus>
              <button class="btn btn-primary" id="scan-add" type="button">
                <i class="bi bi-plus-lg me-1"></i>Add
              </button>
            </div>
            <p class="small mt-2 mb-0 text-muted" id="scan-status">
              Settings stick across sessions. Just paste / type → Enter.
            </p>
          </div>
        </div>

        <h6 class="text-uppercase text-muted small mb-2">Recently added</h6>
        <ul class="list-group" id="scan-recent"></ul>
      </div>
    `;

    refreshRecentList();

    const catSel = document.getElementById('scan-category') as HTMLSelectElement;
    const fmtSel = document.getElementById('scan-format') as HTMLSelectElement;
    const inp = document.getElementById('scan-isbn') as HTMLInputElement;
    const addBtn = document.getElementById('scan-add') as HTMLButtonElement;

    catSel.addEventListener('change', () => setStickyCategory(catSel.value as 'Religious' | 'Fiction'));
    fmtSel.addEventListener('change', () => setStickyFormat(fmtSel.value));

    const submit = () => {
        const v = inp.value.trim();
        if (v) lookupAndAdd(v);
    };
    addBtn.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
}
