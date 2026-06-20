import { api } from '../api';
import { getLibraryUsername } from '../context';
import { getUser } from '../auth';
import { navigate } from '../router';
import {
    bookStarsHtml,
    ratingFromClick,
    setStarsFill,
    previewHover,
    clearHover,
} from '../components/star-helpers';

// One unified Rec shape regardless of which row it came from. For
// `next_in_series` we get book_id (it's in the library); for the
// Hardcover rows we get hc_book_id. Stars/heart click handlers
// discriminate on which id is present.
type Rec = {
    kind: 'next_in_series' | 'loved_author' | 'similar_to';
    book_id?: number;
    hc_book_id?: number;
    title: string;
    authors: string;
    series?: string | null;
    series_index?: number | null;
    cover_url: string | null;
    is_owned?: boolean;
    rating?: number;
    is_favorite?: boolean;
    why: string;
};

type RecsPayload = {
    continue: Rec[];
    loved_authors: Rec[];
    similar_to_favorites: Rec[];
    generated_at: number;
};

const ROWS: Array<{
    key: keyof Omit<RecsPayload, 'generated_at'>;
    num: string;
    title: string;
    sub: string;
}> = [
    {
        key: 'continue',
        num: '01',
        title: 'Finish what you started',
        sub: 'Next in series you’re reading',
    },
    {
        key: 'loved_authors',
        num: '02',
        title: 'More from authors you love',
        sub: 'Other works by your gold, silver, and 5★ authors',
    },
    {
        key: 'similar_to_favorites',
        num: '03',
        title: 'Top in your genres',
        sub: 'Top books in the genres your favourites share',
    },
];

export async function renderRecommendations(): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;
    const user = getUser();

    if (!user || user.username !== username) {
        app.innerHTML = `
            <div class="alert alert-info">
                <strong>Sign in to see recommendations.</strong>
                Recommendations are personal — they're built from your
                gold, silver, and 5★ books and series.
            </div>
        `;
        return;
    }

    app.innerHTML = loadingHtml('Building recommendations…');

    // Capture the route at request time. If the user clicks away during
    // the (potentially 30-second) Hardcover compute, we don't want the
    // late response to slam the current page back to /recommendations.
    const startHash = window.location.hash;

    try {
        const data = await api.getRecommendations(username) as RecsPayload;
        if (window.location.hash !== startHash) return;
        render(app, username, data);
    } catch (err: any) {
        if (window.location.hash !== startHash) return;
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load recommendations: ${err.message}
            </div>
        `;
    }
}

function loadingHtml(msg: string): string {
    return `
        <div class="text-center py-5">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
            <p class="text-muted small mt-3 mb-0">${msg}</p>
            <p class="text-muted small mb-0">
                First load can take 10–15 seconds (cached for 24 hours).
            </p>
        </div>
    `;
}

function render(app: HTMLElement, username: string, data: RecsPayload): void {
    const total =
        (data.continue?.length || 0)
        + (data.loved_authors?.length || 0)
        + (data.similar_to_favorites?.length || 0);

    const generated = new Date(data.generated_at * 1000);
    const ageMin = Math.floor((Date.now() - generated.getTime()) / 60000);
    const ageLabel = ageMin < 60
        ? `${ageMin} min ago`
        : `${Math.floor(ageMin / 60)} hr ago`;

    const heading = `
        <div class="d-flex align-items-baseline justify-content-between flex-wrap mb-4">
            <h2 class="mb-0">Recommendations</h2>
            <div class="d-flex align-items-baseline gap-3">
                <span class="text-muted small">Generated ${ageLabel}</span>
                <button class="btn btn-sm btn-outline-secondary" id="recs-refresh-btn">
                    <i class="bi bi-arrow-clockwise"></i> Refresh
                </button>
            </div>
        </div>
    `;

    if (total === 0) {
        app.innerHTML = heading + emptyState();
        wireRefresh(app, username);
        return;
    }

    let html = heading;
    for (const row of ROWS) {
        const items = data[row.key] || [];
        if (!items.length) continue;
        html += renderRow(row.num, row.title, row.sub, items);
    }
    app.innerHTML = html;
    wireCards(app, username);
    wireRefresh(app, username);
}

function renderRow(
    num: string, title: string, sub: string, items: Rec[],
): string {
    let html = `
        <section class="rec-section">
            <div class="rec-section-header">
                <span class="rec-section-num">${num}</span>
                <h3 class="rec-section-title">${title}</h3>
                <span class="rec-section-rule"></span>
            </div>
            <p class="rec-section-subtitle">${sub}</p>
            <div class="rec-row">
    `;
    for (const r of items) html += recCardHtml(r);
    html += `
            </div>
        </section>
    `;
    return html;
}

function recCardHtml(rec: Rec): string {
    const hcId = rec.hc_book_id != null ? String(rec.hc_book_id) : '';
    const bookId = rec.book_id != null ? String(rec.book_id) : '';
    const rating = rec.rating || 0;
    const fav = rec.is_favorite ? '1' : '0';
    const inLib = !!bookId;

    // Width/height attrs reserve aspect-ratio space immediately so the
    // card doesn't collapse to zero height while the HC CDN URL is
    // still loading and then snap to full size on load. The CSS still
    // controls the actual rendered size; these attrs are about the
    // intrinsic ratio the browser uses before the image arrives.
    const cover = rec.cover_url
        ? `<img class="rec-cover" src="${rec.cover_url}"
                alt="${escAttr(rec.title)}"
                width="168" height="252"
                loading="lazy" decoding="async"
                data-role="primary"
                onerror="this.outerHTML='&lt;div class=&quot;rec-cover-placeholder&quot; data-role=&quot;primary&quot;&gt;&lt;i class=&quot;bi bi-book&quot;&gt;&lt;/i&gt;&lt;/div&gt;'"
                referrerpolicy="no-referrer">`
        : `<div class="rec-cover-placeholder" data-role="primary"><i class="bi bi-book"></i></div>`;

    // Stamp shows series for Row 1, "why" verbatim for HC rows. Sea-green
    // accent caps; tiny tail-rule from CSS.
    const stamp = rec.kind === 'next_in_series'
        ? `<span class="rec-stamp">${escText(rec.series || 'Continue')}</span>`
        : `<span class="rec-stamp">${escText(stampLabel(rec))}</span>`;

    const seriesLine = rec.series && rec.kind !== 'next_in_series'
        ? `<div class="rec-series">${escText(rec.series)}${
              rec.series_index != null ? ` #${rec.series_index}` : ''
          }</div>`
        : '';

    const notOwnedHint = (inLib && rec.is_owned === false)
        ? `<div class="rec-not-owned">Don’t own yet</div>`
        : '';

    const stars = bookStarsHtml(rating, { cls: 'rec-star' });

    const heartCls = rec.is_favorite ? 'rec-icon-btn heart-on' : 'rec-icon-btn';
    const heart = `<button class="${heartCls}" data-action="heart" title="Favourite">♥</button>`;
    const dismiss = `<button class="rec-icon-btn" data-action="dismiss" title="Not interested">✕</button>`;

    return `
        <article class="rec-card${inLib && (rating || rec.is_favorite) ? ' rec-card--added' : ''}"
                 data-hc-id="${hcId}"
                 data-book-id="${bookId}"
                 data-rating="${rating}"
                 data-favorite="${fav}">
            <div class="rec-cover-frame">${cover}</div>
            <div class="rec-body">
                ${stamp}
                <div class="rec-title" data-role="primary" title="${escAttr(rec.title)}">
                    ${escText(rec.title)}
                </div>
                <div class="rec-author">${escText(rec.authors)}</div>
                ${seriesLine}
                ${notOwnedHint}
                <div class="rec-why">${escText(rec.why)}</div>
                <div class="rec-actions">
                    <div class="rec-stars" data-rating="${rating}">${stars}</div>
                    <div class="rec-right">${heart}${dismiss}</div>
                </div>
            </div>
        </article>
    `;
}

function stampLabel(rec: Rec): string {
    // Why looks like "Top Fantasy — you loved ...". Pull the stamp text
    // out of it; fall back to a generic label.
    const m = /^(?:By|Top)\s+([^—\-]+?)\s*(?:—|-)\s*/.exec(rec.why || '');
    if (m) return m[1].trim();
    return rec.kind === 'loved_author' ? 'Same author' : 'Recommended';
}

function wireCards(app: HTMLElement, username: string): void {
    let hoverGroup: HTMLElement | null = null;

    // Star hover preview — light up stars up to the hovered position
    // (half- or full-fill on the hovered star based on cursor X).
    app.addEventListener('mousemove', (ev) => {
        const star = (ev.target as HTMLElement).closest<HTMLElement>('.rec-star');
        if (!star) return;
        const group = star.parentElement as HTMLElement | null;
        if (!group) return;
        hoverGroup = group;
        previewHover(
            group.querySelectorAll<HTMLElement>('.rec-star'),
            star,
            (ev as MouseEvent).clientX,
        );
    });
    app.addEventListener('mouseout', (ev) => {
        const star = (ev.target as HTMLElement).closest<HTMLElement>('.rec-star');
        if (!star) return;
        // When the pointer leaves the group entirely, clear hovered state.
        setTimeout(() => {
            if (!hoverGroup) return;
            if (!hoverGroup.matches(':hover')) {
                clearHover(hoverGroup.querySelectorAll<HTMLElement>('.rec-star'));
                hoverGroup = null;
            }
        }, 0);
    });

    // Click delegation — covers primary (cover/title), stars, heart, dismiss.
    app.addEventListener('click', async (ev) => {
        const target = ev.target as HTMLElement;
        const card = target.closest<HTMLElement>('.rec-card');
        if (!card) return;
        const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
        const primary = target.closest<HTMLElement>('[data-role="primary"]');

        // Primary click on cover/title — add or open
        if (!action && primary) {
            await handlePrimary(card, username);
            return;
        }

        if (action === 'rate') {
            const star = target.closest<HTMLElement>('.rec-star');
            const v = parseInt(star?.dataset.val || '0', 10);
            if (!v || !star) return;
            const rating = ratingFromClick(star, ev.clientX, v);
            await handleRate(card, username, rating);
            return;
        }
        if (action === 'heart') {
            await handleHeart(card, username);
            return;
        }
        if (action === 'dismiss') {
            await handleDismiss(card, username);
            return;
        }
    });
}

async function handlePrimary(card: HTMLElement, username: string): Promise<void> {
    const bookId = parseInt(card.dataset.bookId || '0', 10);
    if (bookId) {
        navigate(`#/book/${bookId}`);
        return;
    }
    const hcId = parseInt(card.dataset.hcId || '0', 10);
    if (!hcId) return;
    flashWorking(card);
    try {
        const res = await api.addRecommendationToLibrary(username, hcId, {
            reading_status: 'unread',
            is_owned: 0,
        });
        applyAddedState(card, res);
    } catch (err: any) {
        flashError(card, `Add failed: ${err.message}`);
    }
}

async function handleRate(
    card: HTMLElement, username: string, value: number,
): Promise<void> {
    const bookId = parseInt(card.dataset.bookId || '0', 10);
    flashWorking(card);
    try {
        if (bookId) {
            // Already in library — just update the rating.
            await api.updateBook(username, bookId, {
                rating: value,
                reading_status: 'read',
            });
        } else {
            const hcId = parseInt(card.dataset.hcId || '0', 10);
            if (!hcId) return;
            const res = await api.addRecommendationToLibrary(username, hcId, {
                rating: value,
                reading_status: 'read',
                is_owned: 0,
            });
            card.dataset.bookId = String(res.book_id);
        }
        setRatingUI(card, value);
        card.classList.add('rec-card--added');
    } catch (err: any) {
        flashError(card, `Rate failed: ${err.message}`);
    }
}

async function handleHeart(card: HTMLElement, username: string): Promise<void> {
    const bookId = parseInt(card.dataset.bookId || '0', 10);
    const current = card.dataset.favorite === '1';
    const next = !current;
    flashWorking(card);
    try {
        if (bookId) {
            await api.updateBook(username, bookId, { is_favorite: next });
        } else {
            const hcId = parseInt(card.dataset.hcId || '0', 10);
            if (!hcId) return;
            const res = await api.addRecommendationToLibrary(username, hcId, {
                is_favorite: true,
                reading_status: 'unread',
                is_owned: 0,
            });
            card.dataset.bookId = String(res.book_id);
        }
        setFavUI(card, next);
        card.classList.add('rec-card--added');
    } catch (err: any) {
        flashError(card, `Heart failed: ${err.message}`);
    }
}

async function handleDismiss(card: HTMLElement, username: string): Promise<void> {
    const hcId = parseInt(card.dataset.hcId || '0', 10);
    if (!hcId) {
        // Row 1 (in-library) — dismiss just hides the card locally.
        fadeOutAndRemove(card);
        return;
    }
    try {
        await api.dismissRecommendation(username, hcId);
        fadeOutAndRemove(card);
    } catch (err: any) {
        flashError(card, `Dismiss failed: ${err.message}`);
    }
}

function setRatingUI(card: HTMLElement, value: number): void {
    card.dataset.rating = String(value);
    const stars = card.querySelectorAll<HTMLElement>('.rec-star');
    setStarsFill(stars, value);
    clearHover(stars);
}

function setFavUI(card: HTMLElement, on: boolean): void {
    card.dataset.favorite = on ? '1' : '0';
    const btn = card.querySelector<HTMLElement>('[data-action="heart"]');
    if (btn) btn.classList.toggle('heart-on', on);
}

function applyAddedState(card: HTMLElement, res: any): void {
    if (res?.book_id) card.dataset.bookId = String(res.book_id);
    if (res?.rating != null) setRatingUI(card, res.rating);
    if (res?.is_favorite) setFavUI(card, true);
    card.classList.add('rec-card--added');
}

function flashWorking(card: HTMLElement): void {
    card.style.opacity = '0.65';
    setTimeout(() => { card.style.opacity = ''; }, 450);
}

function flashError(card: HTMLElement, msg: string): void {
    card.style.opacity = '';
    alert(msg);
}

function fadeOutAndRemove(card: HTMLElement): void {
    card.style.transition = 'opacity 180ms';
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 200);
}

function wireRefresh(app: HTMLElement, username: string): void {
    const btn = document.getElementById('recs-refresh-btn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        app.innerHTML = loadingHtml('Recomputing recommendations…');
        const startHash = window.location.hash;
        try {
            const data = await api.refreshRecommendations(username) as RecsPayload;
            if (window.location.hash !== startHash) return;
            render(app, username, data);
        } catch (err: any) {
            if (window.location.hash !== startHash) return;
            app.innerHTML = `
                <div class="alert alert-danger">
                    Refresh failed: ${err.message}
                </div>
            `;
        }
    });
}

function emptyState(): string {
    return `
        <div class="text-center text-muted py-5">
            <i class="bi bi-stars" style="font-size: 3rem;"></i>
            <p class="mt-2 mb-1">No recommendations yet.</p>
            <p class="small">
                Mark some books as gold, silver, or 5/5 so we have signals
                to work with, then check back.
            </p>
        </div>
    `;
}

function escText(s: string): string {
    return (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
    return escText(s).replace(/"/g, '&quot;');
}
