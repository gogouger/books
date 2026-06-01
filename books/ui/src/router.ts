type RouteHandler = (params: Record<string, string>) => void;

interface Route {
    pattern: RegExp;
    keys: string[];
    handler: RouteHandler;
}

const routes: Route[] = [];
let defaultHandler: RouteHandler | null = null;

export function addRoute(
    path: string,
    handler: RouteHandler
): void {
    const keys: string[] = [];
    const pattern = path.replace(/:([^/]+)/g, (_match, key) => {
        keys.push(key);
        return '([^/]+)';
    });
    routes.push({
        pattern: new RegExp(`^${pattern}$`),
        keys,
        handler,
    });
}

export function setDefaultRoute(handler: RouteHandler): void {
    defaultHandler = handler;
}

export function navigate(hash: string): void {
    window.location.hash = hash;
}

export function navigateHome(): void {
    history.pushState(null, '', window.location.pathname);
    handleRoute();
}

let handleRoute: () => void;

export function startRouter(): void {
    handleRoute = () => {
        const raw = window.location.hash.slice(1);
        // Split route path from optional query string ("?k=v&..").
        const qIdx = raw.indexOf('?');
        const hash = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
        const queryStr = qIdx >= 0 ? raw.slice(qIdx + 1) : '';

        if (hash) {
            for (const route of routes) {
                const match = hash.match(route.pattern);
                if (match) {
                    const params: Record<string, string> = {};
                    route.keys.forEach((key, i) => {
                        params[key] = decodeURIComponent(match[i + 1]);
                    });
                    // Fold query string into params (path keys win).
                    if (queryStr) {
                        const sp = new URLSearchParams(queryStr);
                        sp.forEach((v, k) => {
                            if (!(k in params)) params[k] = v;
                        });
                    }
                    route.handler(params);
                    updateActiveNav(hash);
                    return;
                }
            }
        }

        // No hash or no match: render default (library). Preserve any
        // query params from the hash so presets like `#/?view=...` work.
        if (defaultHandler) {
            const params: Record<string, string> = {};
            if (queryStr) {
                const sp = new URLSearchParams(queryStr);
                sp.forEach((v, k) => { params[k] = v; });
            }
            // If the hash held no useful info (no route + no query),
            // strip it so the URL bar stays clean.
            if (window.location.hash && !queryStr) {
                history.replaceState(null, '', window.location.pathname);
            }
            defaultHandler(params);
            updateActiveNav('');
        }
    };

    window.addEventListener('hashchange', handleRoute);
    handleRoute();
}

function updateActiveNav(hash: string): void {
    document.querySelectorAll('#nav-links .nav-link').forEach(link => {
        const href = link.getAttribute('href') || '';
        if (!href || href === '#') {
            link.classList.toggle('active', !hash);
        } else {
            const isActive = hash.startsWith(href.slice(1));
            link.classList.toggle('active', isActive);
        }
    });
}
