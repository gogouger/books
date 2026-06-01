import { bootstrapAuth, getUser, setUser, fetchMe } from './auth';
import { getLibraryUsername } from './context';
import { addRoute, setDefaultRoute, startRouter } from './router';
import { initThemeToggle } from './theme';
import { renderLogin, updateNavbar } from './pages/login';
import { renderLibrary, resetLibraryFilters } from './pages/library';
import { renderBookDetail } from './pages/book-detail';
import { renderSeriesList, resetSeriesFilters } from './pages/series-list';
import { renderSeriesView } from './pages/series-view';
import { renderSeriesEdit } from './pages/series-edit';
import { renderAddBook } from './pages/add-book';
import { renderBookEdit } from './pages/book-edit';

initThemeToggle();

(async () => {
    const username = getLibraryUsername();

    if (!username) {
        // Root "/" -- if single sign-on (or a stored token) identifies us,
        // skip the login page and go straight to our library.
        const me = await fetchMe();
        if (me) {
            setUser(me);
            window.location.href = `/${me.username}/`;
            return;
        }
        renderLogin();
        bootstrapAuth();
        updateNavbar();
        return;
    }

    // "/{username}/" -- make sure we know who we are (SSO header or token)
    // so owner controls (Add Book, etc.) appear without a Google sign-in.
    if (!getUser()) {
        const me = await fetchMe();
        if (me) setUser(me);
    }

    // Library is the default landing — flat list grouped by series
    // (sort=series default, sea-green section headers). The series-tile
    // overview is now a preset on the same page (view=series-cards).
    setDefaultRoute((p) => renderLibrary(p));
    addRoute('/book/:id/edit', (p) => renderBookEdit(p));
    addRoute('/book/:id', (p) => renderBookDetail(p));
    addRoute('/series', (p) => renderLibrary({
        ...p,
        view: 'series-cards',
        category: p.category || 'all',
    }));
    addRoute('/series/:id/edit', (p) => renderSeriesEdit(p));
    addRoute('/series/:id', (p) => renderSeriesView(p));
    addRoute('/library', (p) => renderLibrary(p));
    addRoute('/add', (p) => renderAddBook(p));

    bootstrapAuth();
    updateNavbar();
    startRouter();

    // Reset filters when clicking nav links directly
    document.getElementById('nav-library')?.addEventListener('click', () => {
        resetLibraryFilters();
    });
    document.getElementById('nav-series')?.addEventListener('click', () => {
        // Series link is now a preset on the library page — reset library
        // state so the preset applies cleanly. Also reset the legacy
        // series-list cache in case anything else still touches it.
        resetLibraryFilters();
        resetSeriesFilters();
    });
})();
