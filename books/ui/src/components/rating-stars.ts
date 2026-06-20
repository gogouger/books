// Editable star rating used on the book-edit page. Renders the same
// background-clip:text half-star treatment as the inline card stars,
// but with a dedicated class + a clear-on-click affordance.
import {
    ratingFromClick,
    setStarsFill,
    previewHover,
    clearHover,
} from './star-helpers';

function fillFor(rating: number, star: number): string {
    if (rating >= star) return 'full';
    if (rating >= star - 0.5) return 'half';
    return '';
}

export function ratingStarsHtml(
    rating: number | null,
    editable: boolean = false,
): string {
    const r = Number(rating) || 0;
    let html = `<div class="rating-stars${editable ? ' editable' : ''}" data-rating="${r}">`;
    for (let v = 1; v <= 5; v++) {
        const f = fillFor(r, v);
        html += `<button type="button" class="rating-stars__btn" data-val="${v}" data-fill="${f}"${editable ? '' : ' disabled'}>★</button>`;
    }
    html += '</div>';
    return html;
}

export function attachRatingHandler(
    container: HTMLElement,
    callback: (rating: number) => void,
): void {
    const starsDiv = container.querySelector<HTMLElement>('.rating-stars.editable');
    if (!starsDiv) return;
    const stars = () => starsDiv.querySelectorAll<HTMLElement>('.rating-stars__btn');

    starsDiv.addEventListener('mousemove', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('.rating-stars__btn');
        if (!btn) return;
        previewHover(stars(), btn, e.clientX);
    });
    starsDiv.addEventListener('mouseleave', () => {
        clearHover(stars());
    });

    starsDiv.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('.rating-stars__btn');
        if (!btn) return;
        const v = parseInt(btn.dataset.val || '0', 10);
        if (!v) return;
        const rating = ratingFromClick(btn, e.clientX, v);
        const current = Number(starsDiv.dataset.rating || '0');
        // Click the current rating to clear it.
        const newRating = rating === current ? 0 : rating;

        starsDiv.dataset.rating = String(newRating);
        setStarsFill(stars(), newRating);
        clearHover(stars());
        callback(newRating);
    });
}

export function favoriteButtonHtml(
    isFavorite: boolean,
    editable: boolean,
): string {
    const icon = isFavorite ? 'bi-heart-fill' : 'bi-heart';
    const activeClass = isFavorite ? ' active' : '';
    const editableClass = editable ? ' editable' : '';
    return `<span class="favorite-btn${activeClass}${editableClass}" data-favorite="${isFavorite}">
        <i class="bi ${icon}"></i>
    </span>`;
}

export function attachFavoriteHandler(
    container: HTMLElement,
    callback: (isFavorite: boolean) => void,
): void {
    const btn = container.querySelector('.favorite-btn.editable');
    if (!btn) return;

    btn.addEventListener('click', () => {
        const current = btn.getAttribute('data-favorite') === 'true';
        const newVal = !current;
        btn.setAttribute('data-favorite', String(newVal));
        const icon = btn.querySelector('i')!;
        if (newVal) {
            icon.className = 'bi bi-heart-fill';
            btn.classList.add('active');
        } else {
            icon.className = 'bi bi-heart';
            btn.classList.remove('active');
        }
        callback(newVal);
    });
}
