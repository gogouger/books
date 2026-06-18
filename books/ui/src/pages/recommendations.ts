import { api } from '../api';
import { getLibraryUsername } from '../context';
import { getUser } from '../auth';

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
    in_library_book_id?: number;
    why: string;
};

type RecsPayload = {
    continue: Rec[];
    loved_authors: Rec[];
    similar_to_favorites: Rec[];
    generated_at: number;
};

export async function renderRecommendations(): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;
    const user = getUser();

    if (!user || user.username !== username) {
        app.innerHTML = `
            <div class="alert alert-info">
                <strong>Sign in to see recommendations.</strong>
                Recommendations are personal — they're built from your
                gold/silver/5★ books and series.
            </div>
        `;
        return;
    }

    app.innerHTML = loadingHtml('Building recommendations…');

    try {
        const data = await api.getRecommendations(username) as RecsPayload;
        render(app, username, data);
    } catch (err: any) {
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
    const totalRecs =
        (data.continue?.length || 0)
        + (data.loved_authors?.length || 0)
        + (data.similar_to_favorites?.length || 0);

    const generated = new Date(data.generated_at * 1000);
    const ageMin = Math.floor(
        (Date.now() - generated.getTime()) / 60000,
    );
    const ageLabel = ageMin < 60
        ? `${ageMin} min ago`
        : `${Math.floor(ageMin / 60)} hr ago`;

    const heading = `
        <div class="d-flex align-items-baseline justify-content-between flex-wrap mb-3">
            <h2 class="mb-0">Recommendations</h2>
            <div class="d-flex align-items-baseline gap-3">
                <span class="text-muted small">
                    Generated ${ageLabel}
                </span>
                <button class="btn btn-sm btn-outline-secondary"
                        id="recs-refresh-btn">
                    <i class="bi bi-arrow-clockwise"></i> Refresh
                </button>
            </div>
        </div>
    `;

    if (totalRecs === 0) {
        app.innerHTML = heading + emptyState();
        wireRefresh(app, username);
        return;
    }

    let html = heading;

    if (data.continue?.length) {
        html += renderRow(
            'Finish what you started',
            'Next in series you’re reading',
            data.continue,
            'continue',
        );
    }
    if (data.loved_authors?.length) {
        html += renderRow(
            'More from authors you love',
            'Other works by your gold, silver, and 5★ authors',
            data.loved_authors,
            'loved_authors',
        );
    }
    if (data.similar_to_favorites?.length) {
        html += renderRow(
            'Because you loved…',
            'Books that share themes with your top reads',
            data.similar_to_favorites,
            'similar_to_favorites',
        );
    }

    app.innerHTML = html;
    wireCards(app, username);
    wireRefresh(app, username);
}

function renderRow(
    title: string, subtitle: string, items: Rec[], rowKey: string,
): string {
    let html = `
        <section class="rec-section" data-rec-row="${rowKey}">
            <div class="rec-section-header">
                <h3 class="rec-section-title">${title}</h3>
                <p class="rec-section-subtitle">${subtitle}</p>
            </div>
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
    const inLibrary = rec.kind === 'next_in_series';
    const hcId = rec.hc_book_id != null ? String(rec.hc_book_id) : '';
    const bookId = rec.book_id != null ? String(rec.book_id) : '';

    const cover = rec.cover_url
        ? `<img src="${rec.cover_url}" alt="${escapeAttr(rec.title)}"
                class="rec-card-cover"
                onerror="this.replaceWith(document.createElement('div'))"
                referrerpolicy="no-referrer">`
        : `<div class="rec-card-cover rec-card-cover--placeholder">
               <i class="bi bi-book"></i>
           </div>`;

    const seriesLine = rec.series
        ? `<div class="rec-card-series">
               ${escapeText(rec.series)}${
                   rec.series_index != null ? ` #${rec.series_index}` : ''
               }
           </div>`
        : '';

    const ownedBadge = (inLibrary && rec.is_owned === false)
        ? '<span class="rec-card-tag">Don’t own yet</span>'
        : '';

    const primaryAction = inLibrary
        ? `<a class="btn btn-sm btn-primary"
              href="#/book/${bookId}">Open</a>`
        : `<button class="btn btn-sm btn-primary rec-add-btn"
                   data-hc-id="${hcId}">
              <i class="bi bi-plus-lg"></i> Add
           </button>`;

    const secondaryAction = inLibrary
        ? ''
        : `<button class="btn btn-sm btn-outline-secondary rec-dismiss-btn"
                   data-hc-id="${hcId}"
                   title="Not interested">
              <i class="bi bi-x"></i>
           </button>`;

    return `
        <article class="rec-card" data-hc-id="${hcId}" data-book-id="${bookId}">
            ${cover}
            <div class="rec-card-body">
                <div class="rec-card-title" title="${escapeAttr(rec.title)}">
                    ${escapeText(rec.title)}
                </div>
                <div class="rec-card-author">
                    ${escapeText(rec.authors)}
                </div>
                ${seriesLine}
                ${ownedBadge}
                <div class="rec-card-why">${escapeText(rec.why)}</div>
                <div class="rec-card-actions">
                    ${primaryAction}
                    ${secondaryAction}
                </div>
            </div>
        </article>
    `;
}

function wireCards(app: HTMLElement, username: string): void {
    app.addEventListener('click', async (ev) => {
        const target = ev.target as HTMLElement;
        const addBtn = target.closest<HTMLButtonElement>('.rec-add-btn');
        const dismissBtn = target.closest<HTMLButtonElement>(
            '.rec-dismiss-btn',
        );

        if (addBtn) {
            const hcId = Number(addBtn.dataset.hcId);
            if (!hcId) return;
            const card = addBtn.closest<HTMLElement>('.rec-card');
            if (!card) return;
            addBtn.disabled = true;
            addBtn.innerHTML =
                '<span class="spinner-border spinner-border-sm"></span>';
            try {
                const res = await api.addRecommendationToLibrary(
                    username, hcId,
                );
                card.classList.add('rec-card--added');
                addBtn.outerHTML = `
                    <a class="btn btn-sm btn-success" href="#/book/${res.book_id}">
                        <i class="bi bi-check2"></i> Added
                    </a>
                `;
                // hide the dismiss button — it's already in the library
                card.querySelector<HTMLElement>('.rec-dismiss-btn')?.remove();
            } catch (err: any) {
                addBtn.disabled = false;
                addBtn.innerHTML = '<i class="bi bi-plus-lg"></i> Add';
                alert(`Add failed: ${err.message}`);
            }
            return;
        }

        if (dismissBtn) {
            const hcId = Number(dismissBtn.dataset.hcId);
            if (!hcId) return;
            const card = dismissBtn.closest<HTMLElement>('.rec-card');
            if (!card) return;
            dismissBtn.disabled = true;
            try {
                await api.dismissRecommendation(username, hcId);
                card.style.opacity = '0';
                card.style.transition = 'opacity 200ms';
                setTimeout(() => card.remove(), 220);
            } catch (err: any) {
                dismissBtn.disabled = false;
                alert(`Dismiss failed: ${err.message}`);
            }
            return;
        }
    });
}

function wireRefresh(app: HTMLElement, username: string): void {
    const btn = document.getElementById(
        'recs-refresh-btn',
    ) as HTMLButtonElement | null;
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        app.innerHTML = loadingHtml('Recomputing recommendations…');
        try {
            const data = await api.refreshRecommendations(
                username,
            ) as RecsPayload;
            render(app, username, data);
        } catch (err: any) {
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

function escapeText(s: string): string {
    return (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
    return escapeText(s).replace(/"/g, '&quot;');
}
