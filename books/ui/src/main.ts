import { bootstrapAuth, getUser, setUser, fetchMe } from './auth';
import { getLibraryUsername } from './context';
import { addRoute, setDefaultRoute, startRouter } from './router';
import { initThemeToggle } from './theme';
import { renderLogin, updateNavbar } from './pages/login';
import { renderFavs } from './pages/favs';
import { renderLibrary, resetLibraryFilters } from './pages/library';
import { renderBookDetail } from './pages/book-detail';
import { renderSeriesView } from './pages/series-view';
import { renderSeriesEdit } from './pages/series-edit';
import { renderAddBook } from './pages/add-book';
import { renderBookEdit } from './pages/book-edit';
import { renderScanBooks } from './pages/scan';
import { renderRecommendations } from './pages/recommendations';
import { renderMetrics } from './pages/metrics';

initThemeToggle();

(async () => {
    const username = getLibraryUsername();

    if (!username) {
        // Root "/" — there's no library context yet. Caddy already 302s
        // to /ggouger/ for anonymous, but if we got here anyway (cookie
        // races, future config changes, hand-typed URL), make the SPA
        // also land everyone on Gordon's library so My Favs is the
        // single front door. Logged-in users with a different username
        // still get routed to their own library via fetchMe.
        const me = await fetchMe();
        if (me) {
            setUser(me);
            window.location.href = `/${me.username}/`;
            return;
        }
        window.location.href = '/ggouger/';
        return;
    }

    // "/{username}/" -- always refresh the user from the server so a stale
    // localStorage entry can't keep showing wrong display data forever. If the
    // backend says no user (401 / no session), clear local state.
    const me = await fetchMe();
    if (me) {
        setUser(me);
    } else if (getUser()) {
        // We had a stale user cached and the server says we're no longer
        // authenticated — drop it so navbar renders the anonymous state.
        localStorage.removeItem('books_user');
    }

    // Landing is now the curated "My Favs" view. The full library lives
    // at /library; /series/:id detail and /series/:id/edit still work for
    // clicking into a specific series from a section header.
    setDefaultRoute((_p) => renderFavs());
    addRoute('/favs', (_p) => renderFavs());
    addRoute('/book/:id/edit', (p) => renderBookEdit(p));
    addRoute('/book/:id', (p) => renderBookDetail(p));
    addRoute('/series/:id/edit', (p) => renderSeriesEdit(p));
    addRoute('/series/:id', (p) => renderSeriesView(p));
    addRoute('/library', (p) => renderLibrary(p));
    addRoute('/recommendations', (_p) => renderRecommendations());
    addRoute('/metrics', (_p) => renderMetrics());
    addRoute('/add', (p) => renderAddBook(p));
    addRoute('/scan', (_p) => renderScanBooks());

    bootstrapAuth();
    updateNavbar();
    startRouter();

    // Reset filters when clicking the Library nav link directly
    document.getElementById('nav-library')?.addEventListener('click', () => {
        resetLibraryFilters();
    });
})();
