/* Inline SSO modal — same UX as the personal-site & Meron flow.
   Click "Sign In" → modal pops up → POST to /__authlogin → on success,
   refetch /api/auth/me and re-render rather than full page reload. */

import { fetchMe, setUser } from './auth';
import { updateNavbar } from './pages/login';

let modal: HTMLElement | null = null;

function build(): HTMLElement {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'login-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:1080;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(8,10,9,.55);';
    modal.innerHTML = `
      <div class="login-card" role="dialog" aria-modal="true" aria-label="Sign in to Athenaeum"
           style="position:relative;width:100%;max-width:360px;background:var(--bs-body-bg);
                  color:var(--bs-body-color);border:1px solid var(--bs-border-color);
                  border-radius:12px;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.3);">
        <button class="login-x" type="button" aria-label="Close"
                style="position:absolute;top:8px;right:10px;background:none;border:0;
                       color:var(--bs-secondary-color);font-size:22px;cursor:pointer;
                       padding:2px 7px;line-height:1;">×</button>
        <p class="text-uppercase mb-1" style="font-size:11px;letter-spacing:.16em;">
          <span style="color:var(--bs-secondary-color)">#</span> Sign in
        </p>
        <p class="text-muted small mb-3">One login for the site, Meron &amp; Athenaeum.</p>
        <form class="login-form" novalidate>
          <div class="mb-2">
            <label for="lm-user" class="form-label small mb-1">Username</label>
            <input id="lm-user" name="username" autocomplete="username" autocapitalize="off"
                   spellcheck="false" required class="form-control form-control-sm">
          </div>
          <div class="mb-2">
            <label for="lm-pass" class="form-label small mb-1">Password</label>
            <input id="lm-pass" name="password" type="password" autocomplete="current-password"
                   required class="form-control form-control-sm">
          </div>
          <p class="login-err text-danger small mb-2" role="alert" hidden></p>
          <button class="btn btn-primary btn-sm w-100" type="submit">Sign in</button>
        </form>
      </div>`;
    document.body.appendChild(modal);

    const close = () => { if (modal) { modal.style.display = 'none'; } };
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    modal.querySelector<HTMLElement>('.login-x')!.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && modal.style.display === 'flex') close();
    });

    const form = modal.querySelector<HTMLFormElement>('.login-form')!;
    const err = modal.querySelector<HTMLElement>('.login-err')!;
    const sBtn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.hidden = true;
        sBtn.disabled = true;
        const originalLabel = sBtn.textContent;
        sBtn.textContent = 'Signing in…';
        try {
            const userInput = (form.elements.namedItem('username') as HTMLInputElement).value;
            const passInput = (form.elements.namedItem('password') as HTMLInputElement).value;
            const resp = await fetch('/__authlogin', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({
                    username: userInput,
                    password: passInput,
                    keepMeLoggedIn: true,
                    requestMethod: 'GET',
                    targetURL: window.location.href,
                }),
            });
            const j = await resp.json().catch(() => ({}));
            if (resp.ok && j.status === 'OK') {
                close();
                form.reset();
                // Refresh local state so the navbar + owner controls update.
                const me = await fetchMe();
                if (me) {
                    setUser(me);
                    // Soft refresh — re-render the library page to pick up
                    // owner-only affordances. Hard reload is the simplest
                    // path to make every consumer of `user` re-read it.
                    window.location.reload();
                }
                return;
            }
            throw new Error(j.message || 'Invalid username or password');
        } catch (e2: any) {
            err.textContent = e2?.message || 'Login failed';
            err.hidden = false;
        } finally {
            sBtn.disabled = false;
            sBtn.textContent = originalLabel;
        }
    });
    return modal;
}

export function openSignInModal(): void {
    const m = build();
    m.style.display = 'flex';
    setTimeout(() => {
        const u = m.querySelector<HTMLInputElement>('#lm-user');
        u?.focus();
    }, 30);
}
