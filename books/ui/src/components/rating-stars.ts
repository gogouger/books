export function ratingStarsHtml(
    rating: number | null,
    editable: boolean = false
): string {
    const r = rating || 0;
    let html = `<div class="rating-stars${editable ? ' editable' : ''}" data-rating="${r}">`;
    for (let i = 1; i <= 5; i++) {
        if (r >= i) {
            html += `<i class="bi bi-star-fill star filled" data-value="${i}"></i>`;
        } else {
            html += `<i class="bi bi-star star" data-value="${i}"></i>`;
        }
    }
    html += '</div>';
    return html;
}

export function attachRatingHandler(
    container: HTMLElement,
    callback: (rating: number) => void
): void {
    const starsDiv = container.querySelector('.rating-stars.editable');
    if (!starsDiv) return;

    starsDiv.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (!target.classList.contains('star')) return;

        const value = parseInt(target.dataset.value || '0');
        const currentRating = parseInt(
            starsDiv.getAttribute('data-rating') || '0'
        );

        // Click same star = clear to 0
        const newRating = value === currentRating ? 0 : value;

        starsDiv.setAttribute('data-rating', String(newRating));
        starsDiv.innerHTML = '';
        const temp = document.createElement('div');
        temp.innerHTML = ratingStarsHtml(newRating, true);
        const newStars = temp.querySelector('.rating-stars');
        if (newStars) {
            starsDiv.innerHTML = newStars.innerHTML;
        }

        callback(newRating);
    });
}

export function favoriteButtonHtml(
    isFavorite: boolean,
    editable: boolean
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
    callback: (isFavorite: boolean) => void
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
