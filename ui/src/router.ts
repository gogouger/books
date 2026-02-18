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
        const hash = window.location.hash.slice(1);

        if (hash) {
            for (const route of routes) {
                const match = hash.match(route.pattern);
                if (match) {
                    const params: Record<string, string> = {};
                    route.keys.forEach((key, i) => {
                        params[key] = decodeURIComponent(match[i + 1]);
                    });
                    route.handler(params);
                    updateActiveNav(hash);
                    return;
                }
            }
        }

        // No hash or no match: render default (library)
        if (defaultHandler) {
            // Clean URL: remove any hash fragment
            if (window.location.hash) {
                history.replaceState(null, '', window.location.pathname);
            }
            defaultHandler({});
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
