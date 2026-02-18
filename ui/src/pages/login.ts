import { getUser, clearAuth, renderGoogleButton } from '../auth';
import { getLibraryUsername } from '../context';

export function renderLogin(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = `
        <div class="login-container">
            <div class="card shadow-sm">
                <div class="card-body p-4">
                    <h3 class="text-center mb-4">
                        <i class="bi bi-book"></i> Books
                    </h3>
                    <div id="login-error" class="alert alert-danger d-none"></div>
                    <div id="google-signin-button" class="d-flex justify-content-center"></div>
                </div>
            </div>
        </div>
    `;

    renderGoogleButton('google-signin-button');
}

export function updateNavbar(): void {
    const user = getUser();
    const libraryUser = getLibraryUsername();

    const navLinks = document.getElementById('nav-links')!;
    const navUser = document.getElementById('nav-user')!;
    const navUsername = document.getElementById('nav-username')!;
    const navLogout = document.getElementById('nav-logout')!;
    const navSignin = document.getElementById('nav-signin')!;
    const navMyLibrary = document.getElementById('nav-my-library')!;
    const navAddItem = document.getElementById('nav-add-item')!;

    // Reset visibility
    navLinks.style.display = 'none';
    navUser.style.display = 'none';
    navAddItem.style.display = 'none';
    navUsername.textContent = '';
    navLogout.classList.add('d-none');
    navSignin.classList.add('d-none');
    navMyLibrary.classList.add('d-none');

    if (!libraryUser) {
        // Root "/" -- login page
        if (user) {
            // Logged in but at root -- show minimal nav
            navUser.style.display = '';
            navUsername.textContent = user.display_name;
            navLogout.classList.remove('d-none');
            navLogout.onclick = (e) => {
                e.preventDefault();
                clearAuth();
                window.location.href = '/';
            };
        }
        // Not logged in at root: hide everything (login page handles itself)
        return;
    }

    // We're on a library page "/{username}/..."
    navLinks.style.display = '';
    navUser.style.display = '';

    const isOwner = user && user.username === libraryUser;

    if (isOwner) {
        // Owner viewing own library: full controls
        navAddItem.style.display = '';
        navUsername.textContent = user.display_name;
        navLogout.classList.remove('d-none');
        navLogout.onclick = (e) => {
            e.preventDefault();
            clearAuth();
            window.location.href = '/';
        };
    } else if (user) {
        // Logged-in non-owner: read-only, link to own library
        navMyLibrary.classList.remove('d-none');
        navMyLibrary.href = `/${user.username}/`;
        navUsername.textContent = user.display_name;
        navLogout.classList.remove('d-none');
        navLogout.onclick = (e) => {
            e.preventDefault();
            clearAuth();
            window.location.href = '/';
        };
    } else {
        // Anonymous visitor: read-only, show sign-in link
        navSignin.classList.remove('d-none');
    }
}
