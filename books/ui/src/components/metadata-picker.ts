import { setupSeriesPicker, SeriesInfo } from './series-picker';

export interface MetaSource {
    title: string;
    authors: string;
    description: string;
    isbn: string;
    published_date: string;
    cover_url: string | null;
    series: string;
    series_index: string;
}

export interface SourceEntry {
    key: string;
    label: string;
    data: MetaSource | null;
    error: string | null;
}

export interface PickerOptions {
    sources: SourceEntry[];
    submitLabel: string;
    onApply: (values: Record<string, string>, coverUrl: string | null) => Promise<void>;
    onCancel: () => void;
    seriesList?: SeriesInfo[];
}

export const META_FIELDS: { key: keyof MetaSource; label: string; type: 'text' | 'textarea' | 'cover' }[] = [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'authors', label: 'Authors', type: 'text' },
    { key: 'series', label: 'Series', type: 'text' },
    { key: 'series_index', label: 'Series #', type: 'text' },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'isbn', label: 'ISBN', type: 'text' },
    { key: 'published_date', label: 'Published Date', type: 'text' },
    { key: 'cover_url', label: 'Cover', type: 'cover' },
];

export function fieldHasValue(source: MetaSource, key: keyof MetaSource): boolean {
    const val = source[key];
    if (val === null || val === undefined) return false;
    if (typeof val === 'string' && val.trim() === '') return false;
    return true;
}

export function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function escapeAttr(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function pickDefault(key: keyof MetaSource, sources: SourceEntry[]): string {
    for (const source of sources) {
        if (source.data && fieldHasValue(source.data, key)) {
            return source.key;
        }
    }
    return sources[0]?.key || '';
}

export function renderMetadataPicker(
    container: HTMLElement,
    options: PickerOptions,
): void {
    const { sources, submitLabel, onApply, onCancel, seriesList } = options;

    // Filter to sources that have data or errors
    const activeSources = sources.filter(s => s.data || s.error);
    if (activeSources.length === 0) {
        container.innerHTML = `
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Metadata</h5>
                        <button type="button" class="btn-close" id="picker-close-empty"></button>
                    </div>
                    <div class="modal-body">
                        <p class="mb-0">No metadata found from any source.</p>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('picker-close-empty')!.addEventListener('click', onCancel);
        return;
    }

    let fieldsHtml = '';
    for (const field of META_FIELDS) {
        fieldsHtml += `<div class="meta-field-row">`;
        fieldsHtml += `<div class="fw-bold mb-2">${field.label}</div>`;

        for (const source of activeSources) {
            const hasData = source.data && fieldHasValue(source.data, field.key);
            const disabled = !hasData;
            const disabledClass = disabled ? 'meta-source-disabled' : '';
            const val = hasData ? (source.data as MetaSource)[field.key] : '';
            const displayVal = hasData ? String(val) : '(no data)';

            const checked = pickDefault(field.key, activeSources) === source.key;

            fieldsHtml += `<div class="form-check ${disabledClass} mb-1">`;
            fieldsHtml += `<input class="form-check-input" type="radio"
                name="meta-${field.key}" value="${source.key}"
                id="meta-${field.key}-${source.key}"
                ${checked ? 'checked' : ''}
                ${disabled ? 'disabled' : ''}>`;
            const errorBadge = (source.error && !hasData)
                ? ` <i class="bi bi-exclamation-triangle-fill text-warning small" title="${escapeAttr(source.error)}"></i>`
                : '';
            fieldsHtml += `<label class="form-check-label small" for="meta-${field.key}-${source.key}">
                <strong>${source.label}</strong>${errorBadge}
            </label>`;

            if (field.type === 'cover') {
                if (hasData && val) {
                    fieldsHtml += `<div class="mt-1"><img src="${escapeAttr(String(val))}"
                        class="meta-cover-thumb" alt="${source.label} cover"></div>`;
                } else {
                    fieldsHtml += `<div class="mt-1 text-muted small">(no cover)</div>`;
                }
            } else if (field.type === 'textarea') {
                fieldsHtml += `<textarea class="form-control form-control-sm mt-1"
                    rows="3" id="meta-input-${field.key}-${source.key}"
                    ${disabled ? 'disabled' : ''}>${escapeHtml(String(displayVal))}</textarea>`;
            } else {
                fieldsHtml += `<input type="text" class="form-control form-control-sm mt-1"
                    value="${escapeAttr(String(displayVal))}"
                    id="meta-input-${field.key}-${source.key}"
                    ${disabled ? 'disabled' : ''}>`;
            }

            fieldsHtml += `</div>`;
        }

        // Add custom series autocomplete option
        if (field.key === 'series' && seriesList) {
            const anySourceHasData = activeSources.some(
                s => s.data && fieldHasValue(s.data, 'series')
            );
            const checked = !anySourceHasData ? 'checked' : '';
            fieldsHtml += `<div class="form-check mb-1">`;
            fieldsHtml += `<input class="form-check-input" type="radio"
                name="meta-series" value="custom"
                id="meta-series-custom" ${checked}>`;
            fieldsHtml += `<label class="form-check-label small" for="meta-series-custom">
                <strong>Custom</strong>
            </label>`;
            fieldsHtml += `<div style="position:relative"><input type="text"
                class="form-control form-control-sm mt-1"
                id="meta-input-series-custom"
                placeholder="Search series..."></div>`;
            fieldsHtml += `</div>`;
        }

        fieldsHtml += `</div>`;

        // Add series numbers container after the series field row
        if (field.key === 'series' && seriesList) {
            fieldsHtml += `<div id="picker-series-numbers"></div>`;
        }
    }

    container.innerHTML = `
        <div class="modal-dialog modal-xl modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Select Metadata</h5>
                    <button type="button" class="btn-close" id="picker-cancel"></button>
                </div>
                <div class="modal-body">
                    ${fieldsHtml}
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" id="picker-cancel-btn">Cancel</button>
                    <button type="button" class="btn btn-primary" id="picker-apply-btn">
                        <i class="bi bi-check-lg"></i> ${escapeHtml(submitLabel)}
                    </button>
                </div>
            </div>
        </div>
    `;

    document.getElementById('picker-cancel')!.addEventListener('click', onCancel);
    document.getElementById('picker-cancel-btn')!.addEventListener('click', onCancel);

    // Auto-select radio when clicking into any source's text input
    for (const field of META_FIELDS) {
        for (const source of activeSources) {
            const inp = document.getElementById(
                `meta-input-${field.key}-${source.key}`
            );
            const radio = document.getElementById(
                `meta-${field.key}-${source.key}`
            ) as HTMLInputElement | null;
            if (inp && radio && !radio.disabled) {
                inp.addEventListener('focus', () => {
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change'));
                });
            }
        }
    }

    // Set up series autocomplete and numbers display
    if (seriesList) {
        const customInput = document.getElementById(
            'meta-input-series-custom'
        ) as HTMLInputElement | null;
        const numbersContainer = document.getElementById(
            'picker-series-numbers'
        );
        const customRadio = document.getElementById(
            'meta-series-custom'
        ) as HTMLInputElement | null;

        if (numbersContainer) {
            // Show series books for any series name from seriesList
            const showBooks = (name: string) => {
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
            };

            // Read series name from whichever radio is selected
            const updateFromRadio = () => {
                const sel = (container.querySelector(
                    'input[name="meta-series"]:checked'
                ) as HTMLInputElement)?.value;
                if (!sel) return;
                if (sel === 'custom') {
                    showBooks(customInput?.value.trim() || '');
                } else {
                    const inp = document.getElementById(
                        `meta-input-series-${sel}`
                    ) as HTMLInputElement | null;
                    showBooks(inp?.value.trim() || '');
                }
            };

            // Listen for radio changes on all series sources
            container.querySelectorAll<HTMLInputElement>(
                'input[name="meta-series"]'
            ).forEach(radio => {
                radio.addEventListener('change', updateFromRadio);
            });

            // Set up autocomplete on custom input
            if (customInput) {
                setupSeriesPicker({
                    input: customInput,
                    seriesList,
                    inline: true,
                    getAuthor: () => {
                        const sel = (container.querySelector(
                            'input[name="meta-authors"]:checked'
                        ) as HTMLInputElement)?.value;
                        if (!sel) return '';
                        const inp = document.getElementById(
                            `meta-input-authors-${sel}`
                        ) as HTMLInputElement | null;
                        return inp?.value.trim() || '';
                    },
                    numbersContainer,
                });

                // Auto-select custom radio on focus or typing
                const selectCustom = () => {
                    if (customRadio && !customRadio.checked) {
                        customRadio.checked = true;
                        customRadio.dispatchEvent(
                            new Event('change')
                        );
                    }
                };
                customInput.addEventListener('focus', selectCustom);
                customInput.addEventListener('input', selectCustom);
            }

            // Show initial series numbers for pre-selected source
            updateFromRadio();
        }
    }

    document.getElementById('picker-apply-btn')!.addEventListener('click', async () => {
        const applyBtn = document.getElementById('picker-apply-btn') as HTMLButtonElement;
        applyBtn.disabled = true;
        applyBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Applying...';

        try {
            const values: Record<string, string> = {};
            let coverUrl: string | null = null;

            for (const field of META_FIELDS) {
                const selected = (document.querySelector(
                    `input[name="meta-${field.key}"]:checked`
                ) as HTMLInputElement)?.value;
                if (!selected) continue;

                if (field.type === 'cover') {
                    // Find the source and get its cover_url
                    const src = activeSources.find(s => s.key === selected);
                    if (src?.data?.cover_url) {
                        coverUrl = src.data.cover_url;
                    }
                } else {
                    const inputId = `meta-input-${field.key}-${selected}`;
                    const input = document.getElementById(inputId) as HTMLInputElement | HTMLTextAreaElement;
                    if (input) {
                        const val = input.value.trim();
                        if (val && val !== '(no data)') {
                            values[field.key] = val;
                        }
                    }
                }
            }

            await onApply(values, coverUrl);
        } catch (err: any) {
            applyBtn.disabled = false;
            applyBtn.innerHTML = `<i class="bi bi-check-lg"></i> ${escapeHtml(submitLabel)}`;
            const footer = container.querySelector('.modal-footer')!;
            const existing = footer.querySelector('.alert');
            if (existing) existing.remove();
            const alert = document.createElement('div');
            alert.className = 'alert alert-danger py-1 px-2 mb-0 me-auto small';
            alert.textContent = err.message;
            footer.prepend(alert);
        }
    });
}
