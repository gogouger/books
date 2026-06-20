// Star rendering + input helpers shared by book cards, series cards,
// rec cards, and the book-edit page.
//
// Display: each star is a single <button> rendering ★. Fill is driven by
// the `data-fill` attribute (`""` / `"half"` / `"full"`). CSS paints the
// fill via a linear-gradient + background-clip:text on the glyph itself,
// so half-stars work with no extra DOM.
//
// Input: clicks land on a single star button. The click X relative to the
// star's bounding box decides whether the rating becomes `v - 0.5` (left
// half) or `v` (right half). Same logic drives hover preview via the
// `data-hover-fill` attribute.

export type StarFill = '' | 'half' | 'full';

function fillFor(rating: number, star: number): StarFill {
    if (rating >= star) return 'full';
    if (rating >= star - 0.5) return 'half';
    return '';
}

// Inline stars on book cards / rec cards. `cls` lets callers swap in a
// page-specific class without forking the helper.
export function bookStarsHtml(
    rating: number | null | undefined,
    opts: { cls?: string } = {},
): string {
    const r = Number(rating) || 0;
    const cls = opts.cls || 'card-star';
    let html = '';
    for (let v = 1; v <= 5; v++) {
        const f = fillFor(r, v);
        html += `<button type="button" class="${cls}" data-action="rate" data-val="${v}" data-fill="${f}">★</button>`;
    }
    return html;
}

// Series-card stars. Same fill logic but with the data attrs the series
// click handler expects (`data-rate` + `data-series-id`).
export function seriesStarsHtml(
    rating: number | null | undefined,
    seriesId: number,
): string {
    const r = Number(rating) || 0;
    let html = '';
    for (let v = 1; v <= 5; v++) {
        const f = fillFor(r, v);
        const title = `${v} star${v !== 1 ? 's' : ''}`;
        html += `<button type="button" class="series-card-star" data-action="rate" data-rate="${v}" data-fill="${f}" data-series-id="${seriesId}" title="${title}">★</button>`;
    }
    return html;
}

// Click X → rating value. Left half of a star button = v - 0.5; right
// half = v. Returns the rating the click would set.
export function ratingFromClick(
    star: HTMLElement,
    clientX: number,
    val: number,
): number {
    const rect = star.getBoundingClientRect();
    const half = clientX - rect.left < rect.width / 2;
    return half ? val - 0.5 : val;
}

// Refresh the `data-fill` (or `data-hover-fill`) attribute on every star
// in a row to match the given rating.
export function setStarsFill(
    stars: ArrayLike<HTMLElement>,
    rating: number,
    attr: 'fill' | 'hoverFill' = 'fill',
): void {
    for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const v = i + 1;
        s.dataset[attr] = fillFor(rating, v);
    }
}

// Hover preview helper: highlight stars up to and including the hovered
// one, with the hovered star half- or full-filled based on cursor X.
export function previewHover(
    stars: ArrayLike<HTMLElement>,
    hovered: HTMLElement,
    clientX: number,
): void {
    const v = parseInt(hovered.dataset.val || hovered.dataset.rate || '0', 10);
    const rect = hovered.getBoundingClientRect();
    const half = clientX - rect.left < rect.width / 2;
    for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const sv = i + 1;
        if (sv < v) s.dataset.hoverFill = 'full';
        else if (sv === v) s.dataset.hoverFill = half ? 'half' : 'full';
        else s.dataset.hoverFill = '';
    }
}

export function clearHover(stars: ArrayLike<HTMLElement>): void {
    for (let i = 0; i < stars.length; i++) {
        stars[i].dataset.hoverFill = '';
    }
}
