import { navigate } from '../router';
import { getUser, clearAuth, renderGoogleButton } from '../auth';

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
    const navUser = document.getElementById('nav-user')!;
    const navLinks = document.getElementById('nav-links')!;
    const navUsername = document.getElementById('nav-username')!;
    const navLogout = document.getElementById('nav-logout')!;

    if (user) {
        navLinks.style.display = '';
        navUser.style.display = '';
        navUsername.textContent = user.display_name;
        navLogout.onclick = (e) => {
            e.preventDefault();
            clearAuth();
            navigate('#/login');
            updateNavbar();
        };
    } else {
        navLinks.style.display = 'none';
        navUser.style.display = 'none';
    }
}
