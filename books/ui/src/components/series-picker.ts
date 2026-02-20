export interface SeriesInfo {
    id: number;
    name: string;
    authors: string;
    books: { index: number | null; title: string }[];
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function authorMatchScore(
    seriesAuthors: string,
    queryAuthor: string,
): number {
    if (!seriesAuthors || !queryAuthor) return 0;
    const sa = seriesAuthors.toLowerCase();
    // Check each author separated by comma or ampersand
    const parts = queryAuthor.toLowerCase().split(/[,&]/).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
        if (sa.includes(part)) return 2;
        const words = part.split(/\s+/);
        const lastName = words[words.length - 1];
        if (lastName.length > 2 && sa.includes(lastName)) return 1;
    }
    return 0;
}

export function setupSeriesPicker(opts: {
    input: HTMLInputElement;
    seriesList: SeriesInfo[];
    getAuthor: () => string;
    numbersContainer: HTMLElement;
    inline?: boolean;
}): void {
    const { input, seriesList, getAuthor, numbersContainer, inline } = opts;

    // Disable browser autocomplete
    input.setAttribute('autocomplete', 'off');

    // Create dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'series-autocomplete-dropdown';
    if (inline) {
        // Render in normal document flow (works inside overflow containers)
        dropdown.style.position = 'static';
    } else {
        input.parentElement!.style.position = 'relative';
    }
    input.insertAdjacentElement('afterend', dropdown);

    function getFiltered(query: string): SeriesInfo[] {
        const q = query.toLowerCase();
        const filtered = q
            ? seriesList.filter(s => s.name.toLowerCase().includes(q))
            : [...seriesList];

        const author = getAuthor();
        if (author) {
            filtered.sort((a, b) => {
                const aScore = authorMatchScore(a.authors, author);
                const bScore = authorMatchScore(b.authors, author);
                if (aScore !== bScore) return bScore - aScore;
                return a.name.localeCompare(b.name);
            });
        }

        return filtered;
    }

    function renderDropdown(): void {
        const query = input.value.trim();
        const items = getFiltered(query);

        if (items.length === 0) {
            dropdown.style.display = 'none';
            return;
        }

        const author = getAuthor();
        dropdown.innerHTML = items.slice(0, 20).map(s => {
            const isMatch = author && authorMatchScore(s.authors, author) > 0;
            const authorHtml = s.authors
                ? ` <small class="text-muted">- ${escapeHtml(s.authors)}</small>`
                : '';
            const count = s.books.length;
            const countHtml = count
                ? `<small class="text-muted float-end">${count}</small>`
                : '';
            return `<button type="button"
                class="list-group-item list-group-item-action py-1 px-2${isMatch ? ' series-author-match' : ''}"
                data-series-name="${escapeAttr(s.name)}">
                <span>${escapeHtml(s.name)}</span>${authorHtml}${countHtml}
            </button>`;
        }).join('');

        dropdown.style.display = 'block';

        dropdown.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const name = (btn as HTMLElement).dataset.seriesName!;
                input.value = name;
                dropdown.style.display = 'none';
                updateNumbers(name);
            });
        });
    }

    function updateNumbers(seriesName?: string): void {
        const name = seriesName || input.value.trim();
        const series = seriesList.find(
            s => s.name.toLowerCase() === name.toLowerCase()
        );

        if (!series || series.books.length === 0) {
            numbersContainer.innerHTML = '';
            return;
        }

        const entries = series.books
            .filter(b => b.index != null)
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map(b => {
                const idx = Number.isInteger(b.index)
                    ? String(b.index)
                    : (b.index ?? 0).toFixed(1);
                return `#${idx} ${escapeHtml(b.title)}`;
            });

        if (entries.length === 0) {
            numbersContainer.innerHTML = '';
            return;
        }

        numbersContainer.innerHTML =
            `<small class="text-muted">In series: ${entries.join(', ')}</small>`;
    }

    input.addEventListener('input', renderDropdown);
    input.addEventListener('focus', renderDropdown);
    input.addEventListener('blur', () => {
        setTimeout(() => {
            dropdown.style.display = 'none';
        }, 150);
        updateNumbers();
    });

    // Show numbers for pre-filled value (edit page)
    if (input.value.trim()) {
        updateNumbers();
    }
}
