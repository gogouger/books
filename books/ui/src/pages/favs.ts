import { api } from '../api';
import { getLibraryUsername } from '../context';
import { bookGridHtml, attachGridClickHandlers } from '../components/book-grid';
import { setAuthorFilter } from './library';
import { navigateHome } from '../router';

// Landing page. Shows the books Gordon has hearted (is_favorite=1) — the
// "shelf I'd recommend to a friend" view. Anything else lives on /library.
export async function renderFavs(): Promise<void> {
    const app = document.getElementById('app')!;
    const username = getLibraryUsername()!;

    app.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
        </div>
    `;

    try {
        const data = await api.getBooks(username, {
            is_favorite: true,
            limit: 1000,
            sort: 'title',
            order: 'asc',
        });

        const heading = `
            <div class="d-flex align-items-baseline justify-content-between flex-wrap mb-3">
                <h2 class="mb-0">My Favs</h2>
                <a href="#/library" class="text-muted small">
                    Browse the full library <i class="bi bi-arrow-right"></i>
                </a>
            </div>
        `;

        if (!data.books.length) {
            app.innerHTML = heading + `
                <div class="text-center text-muted py-5">
                    <i class="bi bi-heart" style="font-size: 3rem;"></i>
                    <p class="mt-2 mb-1">No favorites yet.</p>
                    <p class="small">
                        Heart a book from the
                        <a href="#/library">library</a> to add it here.
                    </p>
                </div>
            `;
            return;
        }

        app.innerHTML = heading + bookGridHtml(data.books);
        attachGridClickHandlers(app, (author) => {
            setAuthorFilter(author);
            navigateHome();
        });
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load favorites: ${err.message}
            </div>
        `;
    }
}
