import { bootstrapAuth } from './auth';
import { getLibraryUsername } from './context';
import { addRoute, setDefaultRoute, startRouter } from './router';
import { renderLogin, updateNavbar } from './pages/login';
import { renderLibrary } from './pages/library';
import { renderBookDetail } from './pages/book-detail';
import { renderSeriesList } from './pages/series-list';
import { renderSeriesView } from './pages/series-view';
import { renderAddBook } from './pages/add-book';

const username = getLibraryUsername();

if (!username) {
    // Root "/" -- show login page
    renderLogin();
    bootstrapAuth();
    updateNavbar();
} else {
    // "/{username}/" -- library is the default (no hash)
    setDefaultRoute(() => renderLibrary());
    addRoute('/book/:id', (p) => renderBookDetail(p));
    addRoute('/series', () => renderSeriesList());
    addRoute('/series/:name', (p) => renderSeriesView(p));
    addRoute('/add', () => renderAddBook());

    bootstrapAuth();
    updateNavbar();
    startRouter();
}
