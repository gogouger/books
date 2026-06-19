import { api } from '../api';
import { getLibraryUsername } from '../context';
import { getUser } from '../auth';
import { navigate } from '../router';

type Metrics = {
    counts: {
        total: number; owned: number; read: number;
        reading: number; unread: number; percent_read: number;
    };
    value: {
        total: number; owned: number; avg: number;
        priced_count: number; unpriced_count: number;
        untagged_count: number;
    };
    tiers: {
        gold: number; silver: number; bronze: number;
        five_star: number; hearted: number;
    };
    formats: Array<{ format: string; count: number; value: number }>;
    read_vs_listened: {
        read: { count: number; value: number };
        listened: { count: number; value: number };
        percent_listened: number;
    };
    categories: Array<{
        name: string; count: number; read: number;
        value: number;
        subgenres: Array<{
            name: string;
            count: number;
            read: number;
            books: Array<{ id: number; title: string; is_read: boolean }>;
        }>;
    }>;
    top_by_value: Array<{
        id: number; title: string; authors: string;
        price: number; format: string | null;
    }>;
};

export async function renderMetrics(): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;
    const user = getUser();

    if (!user || user.username !== username) {
        // Metrics are private. Send the user to their own library; if they
        // don't have one, the existing redirects handle it.
        navigate('#/favs');
        return;
    }

    app.innerHTML = `
        <div class="text-center py-5">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading…</span>
            </div>
            <p class="text-muted small mt-3 mb-0">Crunching the shelf…</p>
        </div>
    `;

    try {
        const m = await api.getMetrics(username) as Metrics;
        render(app, m);
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load metrics: ${escText(err.message || String(err))}
            </div>
        `;
    }
}

function render(app: HTMLElement, m: Metrics): void {
    const usd = (n: number) =>
        `$${n.toLocaleString(undefined, {
            minimumFractionDigits: 2, maximumFractionDigits: 2,
        })}`;

    const autoFillBtn = m.value.unpriced_count > 0
        ? `<button class="btn btn-sm btn-outline-secondary" id="metrics-autofill-btn">
              <i class="bi bi-magic"></i> Auto-fill ${m.value.unpriced_count} prices
           </button>`
        : '';
    const autoTagsBtn = m.value.untagged_count > 0
        ? `<button class="btn btn-sm btn-outline-secondary" id="metrics-autotags-btn">
              <i class="bi bi-tags"></i> Auto-fill ${m.value.untagged_count} tags
           </button>`
        : '';

    app.innerHTML = `
        <div class="d-flex align-items-baseline justify-content-between flex-wrap mb-4 gap-2">
            <h2 class="mb-0">Library metrics</h2>
            <div class="d-flex align-items-baseline gap-3 flex-wrap">
                <span class="text-muted small">${m.counts.total} books in catalog</span>
                ${autoTagsBtn}
                ${autoFillBtn}
            </div>
        </div>
        <div id="metrics-autofill-status"></div>

        ${section('01', 'Overview', '', `
            <div class="metric-tiles">
                ${tile(m.counts.total.toLocaleString(), 'Books in library')}
                ${tile(usd(m.value.total), 'Total spent', m.value.priced_count
                    ? `${m.value.priced_count} of ${m.counts.total} priced`
                    : 'no prices yet')}
                ${tile(usd(m.value.avg), 'Average price', m.value.avg
                    ? `n=${m.value.priced_count}` : '—')}
                ${tile(`${m.counts.percent_read}%`, 'Read', `${m.counts.read} read · ${m.counts.reading} reading · ${m.counts.unread} unread`)}
            </div>
        `)}

        ${section('02', 'Read vs listened', 'Page-eyes vs ear-canals on what you finished', `
            <div class="metric-tiles">
                ${tile(m.read_vs_listened.read.count.toLocaleString(), 'Read', `physical + ebook · ${usd(m.read_vs_listened.read.value)} spent`)}
                ${tile(m.read_vs_listened.listened.count.toLocaleString(), 'Listened', `audiobooks · ${usd(m.read_vs_listened.listened.value)} spent`)}
                ${tile(`${m.read_vs_listened.percent_listened}%`, 'Listened share', `of everything finished`)}
            </div>
        `)}

        ${section('03', 'Tiers', 'Your hand-picked podium', `
            <div class="metric-row">
                ${chip('Gold', m.tiers.gold, 'gold')}
                ${chip('Silver', m.tiers.silver, 'silver')}
                ${chip('Bronze', m.tiers.bronze, 'bronze')}
                ${chip('5 ★', m.tiers.five_star, 'star')}
                ${chip('♥ Hearted', m.tiers.hearted, 'heart')}
            </div>
        `)}

        ${section('04', 'Formats', 'Counts + spend per format', `
            <table class="metrics-table">
                <thead><tr><th>Format</th><th class="num">Count</th><th class="num">Spend</th></tr></thead>
                <tbody>
                    ${m.formats.map(f => `
                        <tr>
                            <td>${escText(formatLabel(f.format))}</td>
                            <td class="num">${f.count.toLocaleString()}</td>
                            <td class="num">${f.value ? usd(f.value) : '—'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `)}

        ${m.categories.map(c => renderCategoryBlock(c, usd)).join('')}

        ${section('99', 'Top by price', 'The most expensive books in the library', m.top_by_value.length ? `
            <table class="metrics-table">
                <thead><tr><th>Title</th><th>Author</th><th>Format</th><th class="num">Price</th></tr></thead>
                <tbody>
                    ${m.top_by_value.map(b => `
                        <tr>
                            <td><a href="#/book/${b.id}">${escText(b.title)}</a></td>
                            <td>${escText(b.authors)}</td>
                            <td class="text-muted">${escText(formatLabel(b.format))}</td>
                            <td class="num">${usd(b.price)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        ` : `<p class="text-muted small mb-0">Add prices to see this list.</p>`)}
    `;

    wireAutofill(app);
    wireAutoTags(app);
}

function wireAutoTags(app: HTMLElement): void {
    const btn = document.getElementById(
        'metrics-autotags-btn',
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const status = document.getElementById('metrics-autofill-status')!;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.innerHTML =
            '<span class="spinner-border spinner-border-sm"></span> Tagging…';
        status.innerHTML = `
            <div class="alert alert-info py-2 small">
                Pulling sub-genre tags from Hardcover — this takes 4–6 minutes for a large library.
            </div>
        `;
        try {
            const username = (
                window.location.pathname.split('/').filter(Boolean)[0] || ''
            );
            const res = await (await import('../api')).api
                .autoTagsLibrary(username);
            status.innerHTML = `
                <div class="alert alert-success py-2 small">
                    Tagged <strong>${res.filled}</strong> books.
                    ${res.no_hc_match ? `${res.no_hc_match} not found on Hardcover.` : ''}
                    ${res.no_genres ? `${res.no_genres} had no genres listed.` : ''}
                    ${res.skipped ? `${res.skipped} skipped.` : ''}
                </div>
            `;
            renderMetrics();
        } catch (err: any) {
            status.innerHTML = `
                <div class="alert alert-danger py-2 small">
                    Auto-tag failed: ${escText(err.message || String(err))}
                </div>
            `;
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-tags"></i> Try again';
        }
    });
}

function wireAutofill(app: HTMLElement): void {
    const btn = document.getElementById(
        'metrics-autofill-btn',
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const status = document.getElementById('metrics-autofill-status')!;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.innerHTML =
            '<span class="spinner-border spinner-border-sm"></span> Filling…';
        status.innerHTML = `
            <div class="alert alert-info py-2 small">
                Looking up prices for unpriced books — this can take 30s for a large library.
            </div>
        `;
        try {
            const username = (
                window.location.pathname.split('/').filter(Boolean)[0] || ''
            );
            const res = await (await import('../api')).api
                .autoPriceLibrary(username);

            const lines: string[] = [];
            lines.push(`Filled <strong>${res.filled}</strong> books — ${res.from_google} from Google Books, ${res.from_default} from format defaults.`);
            if (res.rate_limited) {
                lines.push(res.has_api_key
                    ? `Google rate-limited us mid-batch — daily quota likely hit. Try again tomorrow for the remaining ${res.from_default}.`
                    : `Google rate-limited us (anonymous quota). Set <code>GOOGLE_BOOKS_API_KEY</code> in the VPS .env and re-run for real prices on the ${res.from_default} that fell back to defaults.`);
            } else if (!res.has_api_key && res.from_default > res.from_google) {
                lines.push(`Most fills came from format defaults. Set <code>GOOGLE_BOOKS_API_KEY</code> in the .env for accurate publisher prices.`);
            }
            status.innerHTML = `
                <div class="alert alert-${res.rate_limited ? 'warning' : 'success'} py-2 small">
                    ${lines.join('<br>')}
                </div>
            `;
            // Refetch + re-render metrics
            renderMetrics();
        } catch (err: any) {
            status.innerHTML = `
                <div class="alert alert-danger py-2 small">
                    Auto-fill failed: ${escText(err.message || String(err))}
                </div>
            `;
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-magic"></i> Try again';
        }
    });
}

function renderCategoryBlock(
    c: Metrics['categories'][number],
    usd: (n: number) => string,
): string {
    const num = String(catNumber(c.name)).padStart(2, '0');
    const pct = c.count ? Math.round(100 * c.read / c.count) : 0;
    const subgenresHtml = c.subgenres.length
        ? `<div class="metric-row metric-row--wrap">
              ${c.subgenres.map(s => {
                  const subPct = s.count
                      ? Math.round(100 * s.read / s.count)
                      : 0;
                  // Hover popup with each book in the bucket. Read books
                  // sort first (server-side) and pick up a sea-green dot;
                  // unread books are muted with an outline dot.
                  const popupItems = s.books.map(b => `
                    <a href="#/book/${b.id}" class="metric-pop-item${b.is_read ? ' is-read' : ''}">
                        <span class="metric-pop-dot"></span>
                        ${escText(b.title)}
                    </a>
                  `).join('');
                  const more = s.count > s.books.length
                      ? `<div class="metric-pop-more">+ ${s.count - s.books.length} more</div>`
                      : '';
                  return `
                    <span class="metric-subgenre" tabindex="0">
                        ${escText(s.name)}
                        <span class="metric-subgenre-n">${s.count}</span>
                        <span class="metric-subgenre-pct">${subPct}% read</span>
                        <div class="metric-pop" role="dialog">
                            <div class="metric-pop-h">${escText(s.name)} <span class="text-muted">— ${s.read}/${s.count} read</span></div>
                            <div class="metric-pop-body">${popupItems}</div>
                            ${more}
                        </div>
                    </span>
                  `;
              }).join('')}
           </div>`
        : `<p class="text-muted small mb-0">No sub-genre tags yet.</p>`;

    return section(num, c.name, `${c.count} books · ${pct}% read · ${usd(c.value)} spent`, subgenresHtml);
}

function catNumber(name: string): number {
    if (name === 'Religious') return 5;
    if (name === 'Fiction') return 6;
    return 7;
}

function section(num: string, title: string, subtitle: string, body: string): string {
    return `
        <section class="metric-section">
            <div class="metric-section-header">
                <span class="metric-section-num">${num}</span>
                <h3 class="metric-section-title">${escText(title)}</h3>
                <span class="metric-section-rule"></span>
            </div>
            ${subtitle ? `<p class="metric-section-subtitle">${escText(subtitle)}</p>` : ''}
            ${body}
        </section>
    `;
}

function tile(big: string, label: string, hint = ''): string {
    return `
        <div class="metric-tile">
            <div class="metric-tile-num">${big}</div>
            <div class="metric-tile-label">${escText(label)}</div>
            ${hint ? `<div class="metric-tile-hint">${escText(hint)}</div>` : ''}
        </div>
    `;
}

function chip(label: string, n: number, variant: string): string {
    return `
        <span class="metric-chip metric-chip--${variant}">
            <span class="metric-chip-n">${n}</span>
            <span class="metric-chip-label">${escText(label)}</span>
        </span>
    `;
}

function formatLabel(fmt: string | null | undefined): string {
    if (fmt === 'physical') return 'Physical';
    if (fmt === 'audiobook') return 'Audiobook';
    if (fmt === 'ebook') return 'Ebook';
    return '—';
}

function escText(s: string): string {
    return (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
