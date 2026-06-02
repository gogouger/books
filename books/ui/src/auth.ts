import { apiFetch } from './api';
import { getLibraryUsername } from './context';
import { updateNavbar } from './pages/login';

declare const google: any;

let GOOGLE_CLIENT_ID = '';
const TOKEN_KEY = 'books_id_token';
const EMAIL_HINT_KEY = 'books_email_hint';

let googleInitialized = false;
let lastLoginHint: string | null = null;
let tokenRefreshTimeout: ReturnType<typeof setTimeout> | null = null;

async function loadConfig(): Promise<void> {
    if (GOOGLE_CLIENT_ID) return;
    try {
        const resp = await fetch('/api/config');
        if (resp.ok) {
            const data = await resp.json();
            GOOGLE_CLIENT_ID = data.google_client_id || '';
        }
    } catch {
        // Config fetch failed; Google Sign-In will not work
    }
}

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

function storeEmailHint(token: string): void {
    const decoded = decodeToken(token);
    if (decoded.email) {
        localStorage.setItem(EMAIL_HINT_KEY, decoded.email);
    }
}

function getStoredEmail(): string | null {
    return localStorage.getItem(EMAIL_HINT_KEY);
}

function scheduleTokenRefresh(token: string): void {
    if (tokenRefreshTimeout) clearTimeout(tokenRefreshTimeout);
    const decoded = decodeToken(token);
    const exp = Number(decoded.exp);
    if (!exp) return;
    const timeUntilExpiry = exp * 1000 - Date.now() - 5 * 60 * 1000;
    if (timeUntilExpiry <= 0) {
        clearAuth();
        // Expired Google ID token — let SSO take over on the next request.
        // Do NOT redirect to "/" (causes Caddy → /{username}/ → here loop).
        return;
    }
    tokenRefreshTimeout = setTimeout(() => { trySilentRefresh(); }, timeUntilExpiry);
}

export function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    storeEmailHint(token);
    scheduleTokenRefresh(token);
}

export function clearAuth(): void {
    if (tokenRefreshTimeout) clearTimeout(tokenRefreshTimeout);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('books_user');
    localStorage.removeItem(EMAIL_HINT_KEY);
    if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
        google.accounts.id.disableAutoSelect();
    }
}

export function getUser(): any | null {
    const raw = localStorage.getItem('books_user');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export function setUser(user: any): void {
    // Sanitize: a Caddy placeholder leak ({http.reverse_proxy.header.X}) used
    // to land in display_name. Strip those out so they never reach the navbar.
    if (user && typeof user.display_name === 'string' && user.display_name.indexOf('{') !== -1) {
        user.display_name = user.username || 'me';
    }
    localStorage.setItem('books_user', JSON.stringify(user));
}

// Resolve the current user from the backend. Works with single sign-on
// (the reverse proxy forwards the identity header) OR a stored Google token.
// Returns null when not authenticated. Plain fetch — no 401 login-prompt side
// effects — so it's safe to call on startup.
export async function fetchMe(): Promise<any | null> {
    try {
        const headers: Record<string, string> = {};
        const token = getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const resp = await fetch('/api/auth/me', { credentials: 'include', headers });
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
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
    await loadConfig();
    if (!GOOGLE_CLIENT_ID) return;
    const hint = getStoredEmail();
    if (googleInitialized && hint === lastLoginHint) return;
    await waitForGoogleApi();
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) return;
    const config: Record<string, any> = {
        client_id: GOOGLE_CLIENT_ID,
        callback: async (response: any) => {
            setToken(response.credential);
            if (!getLibraryUsername()) {
                // Initial login from root "/" -- fetch user info and redirect
                try {
                    const me = await apiFetch('/auth/me');
                    setUser(me);
                    window.location.href = `/${me.username}/`;
                } catch (err: any) {
                    clearAuth();
                    const errorEl = document.getElementById('login-error');
                    if (errorEl) {
                        errorEl.textContent = err.message || 'Login failed';
                        errorEl.classList.remove('d-none');
                    }
                }
            } else {
                // Token refresh while browsing -- stay on current page
                updateNavbar();
            }
        },
        auto_select: true,
        use_fedcm_for_prompt: true,
    };
    if (hint) {
        config.login_hint = hint;
    }
    google.accounts.id.initialize(config);
    googleInitialized = true;
    lastLoginHint = hint;
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

async function trySilentRefresh(): Promise<void> {
    await initializeGoogleSignIn();
    if (!googleInitialized) return;
    google.accounts.id.prompt();
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
