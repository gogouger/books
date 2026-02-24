import { bootstrapAuth } from './auth';
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

const username = getLibraryUsername();

if (!username) {
    // Root "/" -- show login page
    renderLogin();
    bootstrapAuth();
    updateNavbar();
} else {
    // "/{username}/" -- library is the default (no hash)
    setDefaultRoute(() => renderLibrary());
    addRoute('/book/:id/edit', (p) => renderBookEdit(p));
    addRoute('/book/:id', (p) => renderBookDetail(p));
    addRoute('/series', () => renderSeriesList());
    addRoute('/series/:id/edit', (p) => renderSeriesEdit(p));
    addRoute('/series/:id', (p) => renderSeriesView(p));
    addRoute('/add', () => renderAddBook());

    bootstrapAuth();
    updateNavbar();
    startRouter();

    // Reset filters when clicking nav links directly
    document.getElementById('nav-library')?.addEventListener('click', () => {
        resetLibraryFilters();
    });
    document.getElementById('nav-series')?.addEventListener('click', () => {
        resetSeriesFilters();
    });
}
