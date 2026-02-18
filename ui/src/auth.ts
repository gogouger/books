import { apiFetch } from './api';
import { navigate } from './router';
import { updateNavbar } from './pages/login';

declare const google: any;

const GOOGLE_CLIENT_ID = '110972621303-tb5jjugmk28id2mu3ttnpvmecu89b6ak.apps.googleusercontent.com';
const TOKEN_KEY = 'books_id_token';

let googleInitialized = false;
let tokenRefreshTimeout: ReturnType<typeof setTimeout> | null = null;

function decodeToken(token: string): any {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return {};
        const payload = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(payload);
    } catch {
        return {};
    }
}

function scheduleTokenRefresh(token: string): void {
    if (tokenRefreshTimeout) clearTimeout(tokenRefreshTimeout);
    const decoded = decodeToken(token);
    const exp = Number(decoded.exp);
    if (!exp) return;
    const timeUntilExpiry = exp * 1000 - Date.now() - 5 * 60 * 1000;
    if (timeUntilExpiry <= 0) {
        clearAuth();
        window.location.hash = '#/login';
        return;
    }
    tokenRefreshTimeout = setTimeout(() => { showLoginPrompt(); }, timeUntilExpiry);
}

export function getToken(): string | null {
    return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
    scheduleTokenRefresh(token);
}

export function clearAuth(): void {
    if (tokenRefreshTimeout) clearTimeout(tokenRefreshTimeout);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem('books_user');
    if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
        google.accounts.id.disableAutoSelect();
    }
}

export function getUser(): any | null {
    const raw = sessionStorage.getItem('books_user');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export function setUser(user: any): void {
    sessionStorage.setItem('books_user', JSON.stringify(user));
}

async function waitForGoogleApi(): Promise<void> {
    if (typeof google !== 'undefined' && google.accounts && google.accounts.id) return;
    return new Promise((resolve) => {
        const interval = setInterval(() => {
            if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
                clearInterval(interval);
                resolve();
            }
        }, 50);
        setTimeout(() => { clearInterval(interval); resolve(); }, 10000);
    });
}

async function initializeGoogleSignIn(): Promise<void> {
    if (googleInitialized) return;
    await waitForGoogleApi();
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) return;
    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (response: any) => {
            setToken(response.credential);
            try {
                const me = await apiFetch('/auth/me');
                setUser(me);
                updateNavbar();
                navigate('#/books');
            } catch (err: any) {
                clearAuth();
                const errorEl = document.getElementById('login-error');
                if (errorEl) {
                    errorEl.textContent = err.message || 'Login failed';
                    errorEl.classList.remove('d-none');
                }
            }
        },
        auto_select: false,
    });
    googleInitialized = true;
}

export async function renderGoogleButton(containerId: string): Promise<void> {
    await initializeGoogleSignIn();
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) return;
    const container = document.getElementById(containerId);
    if (!container) return;
    google.accounts.id.renderButton(container, {
        theme: 'filled_black',
        size: 'large',
        type: 'standard',
        shape: 'rectangular',
    });
}

export async function showLoginPrompt(): Promise<boolean> {
    await initializeGoogleSignIn();
    if (!googleInitialized) return false;
    return new Promise((resolve) => {
        google.accounts.id.prompt((notification: any) => {
            if (notification.isSkippedMoment() || notification.isDismissedMoment()) {
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

export function bootstrapAuth(): void {
    const token = getToken();
    if (token) {
        scheduleTokenRefresh(token);
    }
}
