import { bootstrapAuth, getUser, setUser, fetchMe } from './auth';
import { getLibraryUsername } from './context';
import { addRoute, setDefaultRoute, startRouter } from './router';
import { initThemeToggle } from './theme';
import { renderLogin, updateNavbar } from './pages/login';
import { renderLibrary, resetLibraryFilters } from './pages/library';
import { renderBookDetail } from './pages/book-detail';
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

    // Library is the only browse page (was previously split with /series
    // overview tiles; that got folded in, and now even the in-library
    // series-cards mode is gone — books-grouped + books-flat is enough).
    // /series/:id detail and /series/:id/edit still work for clicking
    // into a specific series from a section header.
    setDefaultRoute((p) => renderLibrary(p));
    addRoute('/book/:id/edit', (p) => renderBookEdit(p));
    addRoute('/book/:id', (p) => renderBookDetail(p));
    addRoute('/series/:id/edit', (p) => renderSeriesEdit(p));
    addRoute('/series/:id', (p) => renderSeriesView(p));
    addRoute('/library', (p) => renderLibrary(p));
    addRoute('/add', (p) => renderAddBook(p));

    bootstrapAuth();
    updateNavbar();
    startRouter();

    // Reset filters when clicking the Library nav link directly
    document.getElementById('nav-library')?.addEventListener('click', () => {
        resetLibraryFilters();
    });
})();
