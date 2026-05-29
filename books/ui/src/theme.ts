type Theme = 'light' | 'dark';

function getTheme(): Theme {
    return (localStorage.getItem('theme') as Theme) || 'light';
}

function applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-bs-theme', theme);
    localStorage.setItem('theme', theme);

    const icon = document.querySelector('#theme-toggle i');
    if (icon) {
        icon.className = theme === 'dark'
            ? 'bi bi-sun-fill'
            : 'bi bi-moon-fill';
    }
}

export function initThemeToggle(): void {
    applyTheme(getTheme());

    const btn = document.getElementById('theme-toggle');
    if (btn) {
        btn.addEventListener('click', () => {
            applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
        });
    }
}
