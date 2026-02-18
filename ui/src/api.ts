import { getToken, clearAuth, showLoginPrompt } from './auth';

const API_BASE = '/api';

export async function apiFetch(
    path: string,
    options: RequestInit = {}
): Promise<any> {
    const token = getToken();
    const headers: Record<string, string> = {
        ...(options.headers as Record<string, string> || {}),
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    const resp = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
    });

    if (resp.status === 401) {
        const refreshed = await showLoginPrompt();
        if (!refreshed) {
            clearAuth();
            window.location.hash = '#/login';
        }
        throw new Error('Not authenticated');
    }

    if (resp.status === 403) {
        clearAuth();
        window.location.hash = '#/login';
        throw new Error('Not authorized');
    }

    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || 'Request failed');
    }

    return resp.json();
}

async function apiFetchRaw(
    path: string,
    options: RequestInit = {}
): Promise<Response> {
    const token = getToken();
    const headers: Record<string, string> = {
        ...(options.headers as Record<string, string> || {}),
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const resp = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
    });

    if (resp.status === 401) {
        const refreshed = await showLoginPrompt();
        if (!refreshed) {
            clearAuth();
            window.location.hash = '#/login';
        }
        throw new Error('Not authenticated');
    }

    if (!resp.ok) {
        throw new Error(`Download failed: ${resp.statusText}`);
    }

    return resp;
}

export const api = {
    async getMe(): Promise<any> {
        return apiFetch('/auth/me');
    },

    async updateKindleEmail(email: string): Promise<any> {
        return apiFetch('/auth/me/kindle', {
            method: 'PATCH',
            body: JSON.stringify({ kindle_email: email }),
        });
    },

    async getBooks(params: Record<string, any> = {}): Promise<any> {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null && v !== '') {
                qs.set(k, String(v));
            }
        }
        return apiFetch(`/books?${qs.toString()}`);
    },

    async getBook(id: number): Promise<any> {
        return apiFetch(`/books/${id}`);
    },

    async updateBook(id: number, updates: Record<string, any>): Promise<any> {
        return apiFetch(`/books/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(updates),
        });
    },

    async deleteBook(id: number): Promise<any> {
        return apiFetch(`/books/${id}`, { method: 'DELETE' });
    },

    async sendToKindle(bookId: number, email?: string): Promise<any> {
        return apiFetch(`/books/${bookId}/kindle`, {
            method: 'POST',
            body: JSON.stringify(email ? { email } : {}),
        });
    },

    async getSeries(): Promise<any> {
        return apiFetch('/series');
    },

    async getSeriesBooks(name: string): Promise<any> {
        return apiFetch(`/series/${encodeURIComponent(name)}`);
    },

    async searchMetadata(query: string, source: string = 'google'): Promise<any> {
        return apiFetch('/metadata/search', {
            method: 'POST',
            body: JSON.stringify({ query, source }),
        });
    },

    async uploadBook(file: File, metadata?: Record<string, any>): Promise<any> {
        const formData = new FormData();
        formData.append('file', file);
        const qs = new URLSearchParams();
        if (metadata) {
            for (const [k, v] of Object.entries(metadata)) {
                if (v !== undefined && v !== null && v !== '') {
                    qs.set(k, String(v));
                }
            }
        }
        const token = getToken();
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const resp = await fetch(`${API_BASE}/books?${qs.toString()}`, {
            method: 'POST',
            headers,
            body: formData,
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || 'Upload failed');
        }
        return resp.json();
    },

    coverUrl(userId: number, coverFilename: string): string {
        return `/covers/${userId}/${coverFilename}`;
    },

    async downloadFile(bookId: number, title: string): Promise<void> {
        const resp = await apiFetchRaw(`/books/${bookId}/file`);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title}.epub`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },
};
