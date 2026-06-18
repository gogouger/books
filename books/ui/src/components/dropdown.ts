/**
 * Native <select> can't be themed past the trigger button — the popup is
 * always the browser default. This is a small custom replacement: a styled
 * button + an anchored panel of items, with keyboard support, click-outside
 * dismissal, and `<hr>` divider entries that real <select> can't render.
 *
 * The DOM contract:
 *   <div class="dd" data-dd-value="…">
 *     <button class="dd-trigger" type="button">…label… <i.bi-chevron-down/></button>
 *     <div class="dd-panel" hidden>…items…</div>
 *   </div>
 *
 * Consumers use `dropdownHtml({...})` to render the markup and
 * `attachDropdown(container, onChange)` to wire behavior. The value flows
 * through `data-dd-value` on the root so existing code that pokes the
 * <select>'s `.value` still works after a 1-line swap.
 */

export interface DropdownItem {
    value: string;
    label: string;
    hr?: boolean;
}

export interface DropdownOpts {
    id: string;
    items: DropdownItem[];
    value: string;
    title?: string;
    // Width hint for the trigger — CSS-valid value (e.g. "180px"). Optional.
    minWidth?: string;
}

function escapeHtml(text: string): string {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function escapeAttr(text: string): string {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

function labelFor(items: DropdownItem[], value: string): string {
    const it = items.find(i => !i.hr && i.value === value);
    return (it?.label || '').trim();
}

export function dropdownHtml(opts: DropdownOpts): string {
    const current = labelFor(opts.items, opts.value);
    const style = opts.minWidth ? ` style="min-width:${opts.minWidth}"` : '';
    let itemsHtml = '';
    for (const it of opts.items) {
        if (it.hr) {
            itemsHtml += '<div class="dd-divider"></div>';
            continue;
        }
        // Preserve leading whitespace from labels like "  └ Commentaries"
        // — strip and render via a wrapper indent instead.
        const trimmed = it.label.trim();
        const indented = it.label.length !== trimmed.length;
        const active = it.value === opts.value ? ' is-active' : '';
        itemsHtml += `<button type="button" class="dd-item${active}${indented ? ' dd-item--indent' : ''}" data-value="${escapeAttr(it.value)}" role="option">${escapeHtml(trimmed)}</button>`;
    }
    return `
        <div class="dd" id="${escapeAttr(opts.id)}" data-dd-value="${escapeAttr(opts.value)}">
            <button type="button" class="dd-trigger"${style}${opts.title ? ` title="${escapeAttr(opts.title)}"` : ''} aria-haspopup="listbox" aria-expanded="false">
                <span class="dd-current">${escapeHtml(current)}</span>
                <i class="bi bi-chevron-down dd-chevron"></i>
            </button>
            <div class="dd-panel" role="listbox" hidden>
                ${itemsHtml}
            </div>
        </div>
    `;
}

/**
 * Wire one or more dropdowns inside `container`. The callback fires with
 * the dropdown id + new value whenever a selection changes.
 */
export function attachDropdowns(
    container: HTMLElement,
    onChange: (id: string, value: string) => void,
): void {
    const dds = container.querySelectorAll<HTMLElement>('.dd');
    if (!dds.length) return;

    const closeAll = (except?: HTMLElement) => {
        dds.forEach(dd => {
            if (dd === except) return;
            const panel = dd.querySelector<HTMLElement>('.dd-panel');
            const trigger = dd.querySelector<HTMLElement>('.dd-trigger');
            if (panel && !panel.hidden) {
                panel.hidden = true;
                trigger?.setAttribute('aria-expanded', 'false');
                dd.classList.remove('is-open');
            }
        });
    };

    dds.forEach(dd => {
        const trigger = dd.querySelector<HTMLElement>('.dd-trigger');
        const panel = dd.querySelector<HTMLElement>('.dd-panel');
        if (!trigger || !panel) return;

        const items = Array.from(panel.querySelectorAll<HTMLElement>('.dd-item'));

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = !panel.hidden;
            if (isOpen) {
                closeAll();
                return;
            }
            closeAll();
            panel.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            dd.classList.add('is-open');
            // Focus the active item (or first) for keyboard nav
            const active = panel.querySelector<HTMLElement>('.dd-item.is-active')
                ?? items[0];
            active?.focus();
        });

        items.forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const value = item.dataset.value || '';
                const label = item.textContent || '';
                const current = dd.querySelector<HTMLElement>('.dd-current');
                if (current) current.textContent = label;
                dd.dataset.ddValue = value;
                items.forEach(i => i.classList.remove('is-active'));
                item.classList.add('is-active');
                panel.hidden = true;
                trigger.setAttribute('aria-expanded', 'false');
                dd.classList.remove('is-open');
                trigger.focus();
                onChange(dd.id, value);
            });
        });

        // Keyboard: arrows move focus, Enter selects, Escape closes
        panel.addEventListener('keydown', (e: KeyboardEvent) => {
            const focused = document.activeElement as HTMLElement | null;
            const idx = focused ? items.indexOf(focused) : -1;
            if (e.key === 'Escape') {
                e.preventDefault();
                panel.hidden = true;
                trigger.setAttribute('aria-expanded', 'false');
                dd.classList.remove('is-open');
                trigger.focus();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = items[(idx + 1) % items.length];
                next?.focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = items[(idx - 1 + items.length) % items.length];
                prev?.focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
                if (focused?.classList.contains('dd-item')) {
                    e.preventDefault();
                    focused.click();
                }
            } else if (e.key === 'Home') {
                e.preventDefault();
                items[0]?.focus();
            } else if (e.key === 'End') {
                e.preventDefault();
                items[items.length - 1]?.focus();
            }
        });

        // Open with arrow keys when trigger is focused
        trigger.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (panel.hidden) trigger.click();
            }
        });
    });

    // Click outside any dropdown closes them all
    document.addEventListener('click', () => closeAll(), { capture: true });
}

/**
 * Set a dropdown's value programmatically (e.g. when the URL pre-selects
 * a filter). Updates the displayed label and the active-item marker.
 */
export function setDropdownValue(container: HTMLElement, id: string, value: string): void {
    const dd = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!dd) return;
    const item = dd.querySelector<HTMLElement>(`.dd-item[data-value="${CSS.escape(value)}"]`);
    if (!item) return;
    dd.dataset.ddValue = value;
    dd.querySelectorAll<HTMLElement>('.dd-item').forEach(i => i.classList.remove('is-active'));
    item.classList.add('is-active');
    const current = dd.querySelector<HTMLElement>('.dd-current');
    if (current) current.textContent = (item.textContent || '').trim();
}
