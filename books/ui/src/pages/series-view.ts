import { api } from '../api';
import { getUser } from '../auth';
import { getLibraryUsername } from '../context';
import { navigateHome } from '../router';
import { bookGridHtml, attachGridClickHandlers } from '../components/book-grid';
import { isHiddenShortStory } from '../components/book-card';
import { invalidateSeriesCache } from './series-list';
import { setAuthorFilter } from './library';

export async function renderSeriesView(
    params: Record<string, string>
): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;
    const seriesId = parseInt(params.id);

    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;

    try {
        const data = await api.getSeriesBooks(username, seriesId);
        const seriesName: string = data.series;
        const hardcoverUrl: string | null = data.hardcover_url;
        const books: any[] = data.books;
        const ghosts: any[] = (data.ghost_entries || []).map((g: any) => ({
            ...g,
            is_ghost: true,
            series: seriesName,
            series_link_id: seriesId,
        }));

        // Sort by hc_position (Hardcover canonical) or series_index
        books.sort((a, b) => {
            const posA = a.hc_position ?? a.series_index ?? 0;
            const posB = b.hc_position ?? b.series_index ?? 0;
            return posA - posB;
        });

        // Merge owned + ghosts ordered by position so the timeline
        // matches the canonical series order. Drop fractional-position
        // novellas the reader hasn't finished — they're noise here.
        const merged: any[] = [...books, ...ghosts]
            .filter(b => !isHiddenShortStory(b))
            .sort((a, b) => {
                const pa = a.hc_position ?? a.series_index ?? a.position ?? 9999;
                const pb = b.hc_position ?? b.series_index ?? b.position ?? 9999;
                return pa - pb;
            });

        const readCount = books.filter(b => b.reading_status === 'read').length;
        const notOwnedCount = books.filter(b => b.is_owned === 0).length;
        const ghostCount = ghosts.length;
        const totalSlots = books.length + ghostCount;
        const notOwnedLabel = notOwnedCount > 0
            ? ` &middot; <span class="text-danger">${notOwnedCount} not owned</span>`
            : '';
        const ghostLabel = ghostCount > 0
            ? ` &middot; <span class="text-muted">${ghostCount} not in library</span>`
            : '';

        const segmentsHtml = renderSegmentedBar(books, ghostCount);
        const isOwner: boolean = data.is_owner;
        const monitored: boolean = data.monitored !== false;
        const seriesComplete: boolean = data.series_complete !== false;

        const editBtn = isOwner
            ? `<a href="#/series/${seriesId}/edit" class="btn btn-outline-primary btn-sm ms-2">
                   <i class="bi bi-pencil"></i> Edit Series
               </a>`
            : '';

        const monitorBtn = isOwner
            ? `<button class="btn btn-outline-${monitored ? 'warning' : 'success'} btn-sm ms-2" id="monitor-toggle"
                       title="${monitored ? 'Hide this series from the list' : 'Show this series in the list'}">
                   <i class="bi bi-${monitored ? 'eye-slash' : 'eye'}"></i>
                   ${monitored ? 'Hide' : 'Unhide'}
               </button>`
            : '';

        const completeBtn = isOwner
            ? `<button class="btn btn-outline-${seriesComplete ? 'warning' : 'success'} btn-sm ms-2" id="complete-toggle"
                       title="${seriesComplete ? 'Mark series as still being written' : 'Mark series as finished by the author'}">
                   <i class="bi bi-${seriesComplete ? 'hourglass-split' : 'check-circle'}"></i>
                   ${seriesComplete ? 'Mark Ongoing' : 'Mark Complete'}
               </button>`
            : '';

        const currentUser = getUser();
        const copySeriesBtn = (!isOwner && currentUser)
            ? `<button class="btn btn-outline-success btn-sm ms-2" id="copy-series-btn">
                   <i class="bi bi-collection"></i> Copy Series
               </button>`
            : '';

        const hcLink = hardcoverUrl
            ? `<a href="${hardcoverUrl}" target="_blank" rel="noopener"
                  class="btn btn-outline-secondary btn-sm ms-2"
                  title="View on Hardcover">
                   <i class="bi bi-box-arrow-up-right"></i> Hardcover
               </a>`
            : '';

        const grLink = `<a href="https://www.google.com/search?q=${encodeURIComponent(seriesName + ' site:goodreads.com/series')}" target="_blank" rel="noopener"
              class="btn btn-outline-secondary btn-sm ms-2"
              title="Search Goodreads series via Google">
                   <i class="bi bi-box-arrow-up-right"></i> Goodreads
               </a>`;

        const userRating: number | null = data.user_rating ?? null;
        const isFavorite: boolean = !!data.is_favorite;
        const isAllTimeFav: boolean = !!data.is_all_time_fav;
        const isSecondFav: boolean = !!data.is_second_fav;
        const isThirdFav: boolean = !!data.is_third_fav;

        const ratingControls = isOwner
            ? renderSeriesRatingControls(userRating, isFavorite, isAllTimeFav, isSecondFav, isThirdFav)
            : renderSeriesRatingReadonly(userRating, isFavorite, isAllTimeFav, isSecondFav, isThirdFav);

        const tierClass =
            isAllTimeFav ? ' series-header--gold'
            : isSecondFav ? ' series-header--silver'
            : isThirdFav ? ' series-header--bronze' : '';

        let html = `
            <div class="d-flex align-items-center flex-wrap gap-1 mb-3">
                <a href="#/series" class="btn btn-outline-secondary btn-sm">
                    <i class="bi bi-arrow-left"></i> All Series
                </a>
                ${editBtn}
                ${monitorBtn}
                ${completeBtn}
                ${copySeriesBtn}
                ${hcLink}
                ${grLink}
            </div>
            <div class="series-header${tierClass} mb-3">
                <h4 class="mb-0">${escapeHtml(seriesName)}</h4>
                ${ratingControls}
            </div>
            <div class="text-muted mb-2">
                ${totalSlots} book${totalSlots !== 1 ? 's' : ''}
                &middot; ${readCount}/${books.length} read${notOwnedLabel}${ghostLabel}
            </div>
            <div class="mb-3">${segmentsHtml}</div>
        `;

        html += `<div class="mb-4">${bookGridHtml(merged)}</div>`;

        app.innerHTML = html;

        attachGridClickHandlers(app, (author) => {
            setAuthorFilter(author);
            navigateHome();
        });

        // Series-level rating + favorite + tier handlers (owner-only)
        if (isOwner) {
            attachSeriesRatingHandlers(app, async (patch) => {
                try {
                    await api.updateSeries(username, seriesId, patch);
                    invalidateSeriesCache();
                    renderSeriesView(params);
                } catch (e: any) {
                    alert(`Failed to update: ${e.message}`);
                }
            });
        }

        const monitorToggle = app.querySelector('#monitor-toggle');
        if (monitorToggle) {
            monitorToggle.addEventListener('click', async () => {
                const newMonitored = !monitored;
                try {
                    await api.updateSeries(username, seriesId, {
                        monitored: newMonitored,
                    });
                    invalidateSeriesCache();
                    renderSeriesView(params);
                } catch (e: any) {
                    alert(`Failed to update: ${e.message}`);
                }
            });
        }

        const completeToggle = app.querySelector('#complete-toggle');
        if (completeToggle) {
            completeToggle.addEventListener('click', async () => {
                const newComplete = !seriesComplete;
                try {
                    await api.updateSeries(username, seriesId, {
                        series_complete: newComplete,
                    });
                    invalidateSeriesCache();
                    renderSeriesView(params);
                } catch (e: any) {
                    alert(`Failed to update: ${e.message}`);
                }
            });
        }

        const copySeriesEl = app.querySelector('#copy-series-btn');
        if (copySeriesEl && currentUser) {
            copySeriesEl.addEventListener('click', async () => {
                const ownedCount = books.filter(b => b.is_owned !== 0).length;
                const ok = confirm(
                    `Copy ${ownedCount} owned book(s) from "${seriesName}" to your library?\n\nBooks you already have will be skipped.`
                );
                if (!ok) return;

                const btn = copySeriesEl as HTMLButtonElement;
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Copying...';
                try {
                    const result = await api.copySeriesFromLibrary(username, seriesId);
                    alert(`Copied ${result.copied} book(s), skipped ${result.skipped}.`);
                    window.location.href = `/${currentUser.username}/#/series`;
                } catch (e: any) {
                    alert(`Failed to copy: ${e.message}`);
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-collection"></i> Copy Series';
                }
            });
        }
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load series: ${err.message}
            </div>
        `;
    }
}

const STATUS_CLASS: Record<string, string> = {
    read: 'segment-read', reading: 'segment-reading',
};

function renderSegmentedBar(books: any[], ghostCount: number = 0): string {
    const segments = books.map(b => {
        const cls = STATUS_CLASS[b.reading_status] || 'segment-unread';
        const owned = b.is_owned !== 0 ? '' : ' segment-not-owned';
        const prog = b.progress || 0;
        if (b.reading_status === 'reading') {
            const pct = Math.round(prog * 100);
            return `<div class="series-segment${owned}" style="border-color:var(--bs-primary);background:linear-gradient(to right,var(--bs-primary) ${pct}%,var(--bs-secondary-bg) ${pct}%)"></div>`;
        }
        return `<div class="series-segment ${cls}${owned}"></div>`;
    });
    for (let i = 0; i < ghostCount; i++) {
        segments.push(`<div class="series-segment segment-ghost"></div>`);
    }
    return `<div class="series-segments">${segments.join('')}</div>`;
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── series-level rating + favorite + tier controls ──────────────────

function renderStars(rating: number | null, editable: boolean): string {
    const r = rating ?? 0;
    const inputs: string[] = [];
    for (let i = 1; i <= 5; i++) {
        const filled = i <= r;
        const icon = filled ? 'bi-star-fill' : 'bi-star';
        const cls = filled ? 'series-star filled' : 'series-star';
        if (editable) {
            inputs.push(`<button type="button" class="${cls}" data-rate="${i}" title="${i} star${i !== 1 ? 's' : ''}"><i class="bi ${icon}"></i></button>`);
        } else {
            inputs.push(`<span class="${cls}"><i class="bi ${icon}"></i></span>`);
        }
    }
    return `<span class="series-stars" data-rating="${r}">${inputs.join('')}</span>`;
}

function renderSeriesRatingControls(
    rating: number | null,
    isFavorite: boolean,
    isAllTime: boolean,
    isSecond: boolean,
    isThird: boolean,
): string {
    const heartIcon = isFavorite ? 'bi-heart-fill' : 'bi-heart';
    const heartCls = isFavorite ? 'series-fav-btn is-on' : 'series-fav-btn';
    const goldCls = isAllTime ? 'series-tier-btn series-tier-btn--gold is-on' : 'series-tier-btn series-tier-btn--gold';
    const silverCls = isSecond ? 'series-tier-btn series-tier-btn--silver is-on' : 'series-tier-btn series-tier-btn--silver';
    const bronzeCls = isThird ? 'series-tier-btn series-tier-btn--bronze is-on' : 'series-tier-btn series-tier-btn--bronze';
    return `
        <div class="series-rating-row">
            ${renderStars(rating, true)}
            <button type="button" class="${heartCls}" id="series-fav-toggle" title="Like series">
                <i class="bi ${heartIcon}"></i>
            </button>
            <button type="button" class="${bronzeCls}" id="series-bronze-toggle" title="Bronze — #3 all-time">
                <i class="bi bi-award"></i>
            </button>
            <button type="button" class="${silverCls}" id="series-silver-toggle" title="Silver — #2 all-time">
                <i class="bi bi-crown"></i>
            </button>
            <button type="button" class="${goldCls}" id="series-gold-toggle" title="Gold — #1 all-time">
                <i class="bi bi-crown-fill"></i>
            </button>
        </div>
    `;
}

function renderSeriesRatingReadonly(
    rating: number | null,
    isFavorite: boolean,
    isAllTime: boolean,
    isSecond: boolean,
    isThird: boolean,
): string {
    if (!rating && !isFavorite && !isAllTime && !isSecond && !isThird) return '';
    const heart = isFavorite
        ? '<span class="series-fav-btn is-on" title="Favorite"><i class="bi bi-heart-fill"></i></span>'
        : '';
    const tier = isAllTime
        ? '<span class="series-tier-btn series-tier-btn--gold is-on" title="#1 all-time"><i class="bi bi-crown-fill"></i></span>'
        : isSecond
            ? '<span class="series-tier-btn series-tier-btn--silver is-on" title="#2 all-time"><i class="bi bi-crown"></i></span>'
        : isThird
            ? '<span class="series-tier-btn series-tier-btn--bronze is-on" title="#3 all-time"><i class="bi bi-award-fill"></i></span>'
            : '';
    return `<div class="series-rating-row">${renderStars(rating, false)}${heart}${tier}</div>`;
}

function attachSeriesRatingHandlers(
    app: HTMLElement,
    onChange: (patch: Record<string, any>) => void | Promise<void>,
): void {
    const stars = app.querySelector<HTMLElement>('.series-stars');
    if (stars) {
        stars.querySelectorAll<HTMLButtonElement>('.series-star[data-rate]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const next = parseInt(btn.dataset.rate || '0', 10);
                const current = parseInt(stars.dataset.rating || '0', 10);
                // Clicking the existing rating clears it.
                onChange({ rating: next === current ? null : next });
            });
        });
    }
    app.querySelector('#series-fav-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = (e.currentTarget as HTMLElement).classList.contains('is-on');
        onChange({ is_favorite: !on });
    });
    app.querySelector('#series-bronze-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = (e.currentTarget as HTMLElement).classList.contains('is-on');
        onChange(on
            ? { is_third_fav: false }
            : { is_third_fav: true, is_second_fav: false, is_all_time_fav: false });
    });
    app.querySelector('#series-silver-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = (e.currentTarget as HTMLElement).classList.contains('is-on');
        onChange(on
            ? { is_second_fav: false }
            : { is_second_fav: true, is_all_time_fav: false, is_third_fav: false });
    });
    app.querySelector('#series-gold-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = (e.currentTarget as HTMLElement).classList.contains('is-on');
        onChange(on
            ? { is_all_time_fav: false }
            : { is_all_time_fav: true, is_second_fav: false, is_third_fav: false });
    });
}
