import { api } from '../api';

export function bookCardHtml(book: any): string {
    if (book.is_ghost) return ghostCardHtml(book);
    const coverImg = book.cover_filename
        ? `<img src="${api.coverUrl(book.user_id, book.cover_filename, book.cover_updated_at)}"
               alt="${escapeHtml(book.title)}" loading="lazy"
               onerror="this.outerHTML='&lt;div class=&quot;no-cover&quot;&gt;&lt;i class=&quot;bi bi-book&quot;&gt;&lt;/i&gt;&lt;/div&gt;'">`
        : `<div class="no-cover"><i class="bi bi-book"></i></div>`;

    const gutterClass = book.reading_status === 'read'
        ? 'gutter-read'
        : book.reading_status === 'reading'
            ? 'gutter-reading'
            : 'gutter-unread';

    const gutterFav = book.is_favorite
        ? '<i class="bi bi-heart-fill gutter-fav"></i>'
        : '';

    let gutterStars = '';
    if (book.rating) {
        for (let i = 5; i >= 1; i--) {
            const filled = i <= book.rating;
            const icon = filled ? 'bi-star-fill' : 'bi-star';
            const cls = filled ? 'gutter-star filled' : 'gutter-star';
            gutterStars += `<i class="bi ${icon} ${cls}"></i>`;
        }
    }

    const seriesText = book.series
        ? `${escapeHtml(book.series)}${book.series_index ? ` #${book.series_index}` : ''}`
        : '';
    const seriesInfo = book.series
        ? book.series_link_id
            ? `<div class="card-series"><a href="#/series/${book.series_link_id}" class="card-series-link">${seriesText}</a></div>`
            : `<div class="card-series">${seriesText}</div>`
        : '';

    const ownedClass = book.is_owned === 0 ? ' not-owned' : '';

    const progressBar = book.reading_status === 'reading' && book.progress
        ? `<div class="card-progress"><div class="card-progress-fill" style="width:${(book.progress * 100).toFixed(1)}%"></div></div>`
        : '';

    // Status badge — shown below title. The colored gutter on the side
    // gives a quick scan; this label spells it out so it's not ambiguous.
    let statusBadge = '';
    if (book.is_owned === 0) {
        statusBadge = '<span class="card-status status-not-owned">Don&rsquo;t own</span>';
    } else if (book.reading_status === 'read') {
        statusBadge = '<span class="card-status status-read"><i class="bi bi-check-circle-fill"></i> Read</span>';
    } else if (book.reading_status === 'reading') {
        const pct = book.progress ? ` ${Math.round(book.progress * 100)}%` : '';
        statusBadge = `<span class="card-status status-reading"><i class="bi bi-book-half"></i> Reading${pct}</span>`;
    }
    // owned + unread = no badge (default state, would be noise on every card)


    return `
        <div class="book-card card${ownedClass}" data-book-id="${book.id}" role="button">
            <div class="cover-container">
                ${coverImg}
                ${progressBar}
            </div>
            <div class="card-info">
                <div class="card-gutter ${gutterClass}">
                    ${gutterFav}
                    <div class="gutter-stars">${gutterStars}</div>
                </div>
                <div class="card-body">
                    <div class="card-title">${escapeHtml(book.title)}</div>
                    <div class="card-author">${authorsHtml(book.authors)}</div>
                    ${seriesInfo}
                    ${statusBadge}
                </div>
            </div>
        </div>
    `;
}

// Ghost: a series_entries row the user doesn't have a book for.
// Renders as a hollow tile with a "Don't own" badge and an
// "Add to library" hint. Click navigates to /add prefilled.
export function ghostCardHtml(book: any): string {
    const seriesText = book.series
        ? `${escapeHtml(book.series)}${book.series_index ? ` #${book.series_index}` : ''}`
        : '';
    const seriesInfo = book.series
        ? book.series_link_id
            ? `<div class="card-series"><a href="#/series/${book.series_link_id}" class="card-series-link">${seriesText}</a></div>`
            : `<div class="card-series">${seriesText}</div>`
        : '';

    const params = new URLSearchParams();
    if (book.title) params.set('title', book.title);
    if (book.authors) params.set('authors', book.authors);
    if (book.series) params.set('series', book.series);
    if (book.series_index !== null && book.series_index !== undefined) {
        params.set('series_index', String(book.series_index));
    }
    const addHref = `#/add?${params.toString()}`;

    // Prefer the Hardcover cover URL on ghost entries when we have
    // one (loads directly from their CDN, no proxy needed). Falls
    // back to the placeholder icon when cover_url is null/empty.
    const coverInner = book.cover_url
        ? `<img src="${escapeAttr(book.cover_url)}"
                alt="${escapeHtml(book.title || '')}" loading="lazy"
                onerror="this.outerHTML='&lt;div class=&quot;no-cover&quot;&gt;&lt;i class=&quot;bi bi-plus-circle&quot;&gt;&lt;/i&gt;&lt;/div&gt;'">`
        : `<div class="no-cover"><i class="bi bi-plus-circle"></i></div>`;

    return `
        <div class="book-card card ghost-card" data-add-href="${escapeAttr(addHref)}" role="button" title="Add to library">
            <div class="cover-container ghost-cover">
                ${coverInner}
                <span class="ghost-badge">Don&rsquo;t own</span>
            </div>
            <div class="card-info">
                <div class="card-gutter gutter-unread"></div>
                <div class="card-body">
                    <div class="card-title">${escapeHtml(book.title || '')}</div>
                    <div class="card-author">${escapeHtml(book.authors || '')}</div>
                    ${seriesInfo}
                </div>
            </div>
        </div>
    `;
}

// Books whose series position has a fractional part (e.g. 1.5, 0.5 — typically
// novellas/short stories) are noise in series views unless the user has read
// them. Integer positions and standalones (no position) are always shown.
// Ghosts come through with `position` instead of `series_index`; check both.
export function isHiddenShortStory(b: any): boolean {
    const raw = b.series_index ?? b.hc_position ?? b.position;
    if (raw == null) return false;
    const idx = Number(raw);
    if (!Number.isFinite(idx) || Number.isInteger(idx)) return false;
    return b.reading_status !== 'read';
}

function escapeAttr(text: string): string {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

function authorsHtml(authors: string): string {
    return authors.split(',').map(a => {
        const trimmed = a.trim();
        return `<span class="card-author-link" data-author="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</span>`;
    }).join(', ');
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
