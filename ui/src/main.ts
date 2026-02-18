import { getToken, bootstrapAuth } from './auth';
import { addRoute, startRouter } from './router';
import { renderLogin, updateNavbar } from './pages/login';
import { renderLibrary } from './pages/library';
import { renderBookDetail } from './pages/book-detail';
import { renderSeriesList } from './pages/series-list';
import { renderSeriesView } from './pages/series-view';
import { renderAddBook } from './pages/add-book';

function requireAuth(handler: (params: Record<string, string>) => void | Promise<void>) {
    return (params: Record<string, string>) => {
        if (!getToken()) {
            window.location.hash = '#/login';
            return;
        }
        handler(params);
    };
}

// Register routes
addRoute('/login', () => renderLogin());
addRoute('/books', requireAuth(() => renderLibrary()));
addRoute('/book/:id', requireAuth((p) => renderBookDetail(p)));
addRoute('/series', requireAuth(() => renderSeriesList()));
addRoute('/series/:name', requireAuth((p) => renderSeriesView(p)));
addRoute('/add', requireAuth(() => renderAddBook()));

// Init
bootstrapAuth();
updateNavbar();
startRouter();
