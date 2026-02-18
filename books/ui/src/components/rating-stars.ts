export function ratingStarsHtml(
    rating: number | null,
    editable: boolean = false
): string {
    const r = rating || 0;
    let html = `<div class="rating-stars${editable ? ' editable' : ''}" data-rating="${r}">`;
    for (let i = 1; i <= 5; i++) {
        if (r >= i) {
            html += `<i class="bi bi-star-fill star filled" data-value="${i}"></i>`;
        } else if (r >= i - 0.5) {
            html += `<i class="bi bi-star-half star filled" data-value="${i - 0.5}"></i>`;
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

        const value = parseFloat(target.dataset.value || '0');
        const currentRating = parseFloat(
            starsDiv.getAttribute('data-rating') || '0'
        );

        // Click same star = toggle half star / clear
        let newRating: number;
        if (value === currentRating) {
            newRating = value - 0.5;
        } else if (value - 0.5 === currentRating) {
            newRating = 0;
        } else {
            newRating = value;
        }

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
