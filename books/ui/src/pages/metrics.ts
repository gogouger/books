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
    };
    tiers: {
        gold: number; silver: number; bronze: number;
        five_star: number; hearted: number;
    };
    formats: Array<{ format: string; count: number; value: number }>;
    categories: Array<{
        name: string; count: number; read: number;
        value: number;
        subgenres: Array<{ name: string; count: number }>;
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

    app.innerHTML = `
        <div class="d-flex align-items-baseline justify-content-between flex-wrap mb-4">
            <h2 class="mb-0">Library metrics</h2>
            <span class="text-muted small">${m.counts.total} books in catalog</span>
        </div>

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

        ${section('02', 'Tiers', 'Your hand-picked podium', `
            <div class="metric-row">
                ${chip('Gold', m.tiers.gold, 'gold')}
                ${chip('Silver', m.tiers.silver, 'silver')}
                ${chip('Bronze', m.tiers.bronze, 'bronze')}
                ${chip('5 ★', m.tiers.five_star, 'star')}
                ${chip('♥ Hearted', m.tiers.hearted, 'heart')}
            </div>
        `)}

        ${section('03', 'Formats', 'Counts + spend per format', `
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

        ${m.top_by_value.length ? section('99', 'Top by price', 'The most expensive books in the library', `
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
        `) : ''}
    `;
}

function renderCategoryBlock(
    c: Metrics['categories'][number],
    usd: (n: number) => string,
): string {
    const num = String(catNumber(c.name)).padStart(2, '0');
    const pct = c.count ? Math.round(100 * c.read / c.count) : 0;
    const subgenresHtml = c.subgenres.length
        ? `<div class="metric-row metric-row--wrap">
              ${c.subgenres.map(s => `
                <span class="metric-subgenre">
                    ${escText(s.name)} <span class="metric-subgenre-n">${s.count}</span>
                </span>
              `).join('')}
           </div>`
        : `<p class="text-muted small mb-0">No sub-genre tags yet.</p>`;

    return section(num, c.name, `${c.count} books · ${pct}% read · ${usd(c.value)} spent`, subgenresHtml);
}

function catNumber(name: string): number {
    if (name === 'Religious') return 4;
    if (name === 'Fiction') return 5;
    return 6;
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
