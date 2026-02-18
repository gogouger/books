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
            window.location.href = '/';
        }
        throw new Error('Not authenticated');
    }

    if (resp.status === 403) {
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
            window.location.href = '/';
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

    async getBooks(username: string, params: Record<string, any> = {}): Promise<any> {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null && v !== '') {
                qs.set(k, String(v));
            }
        }
        return apiFetch(`/${username}/books?${qs.toString()}`);
    },

    async getBook(username: string, id: number): Promise<any> {
        return apiFetch(`/${username}/books/${id}`);
    },

    async updateBook(username: string, id: number, updates: Record<string, any>): Promise<any> {
        return apiFetch(`/${username}/books/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(updates),
        });
    },

    async deleteBook(username: string, id: number): Promise<any> {
        return apiFetch(`/${username}/books/${id}`, { method: 'DELETE' });
    },

    async sendToKindle(username: string, bookId: number, email?: string): Promise<any> {
        return apiFetch(`/${username}/books/${bookId}/kindle`, {
            method: 'POST',
            body: JSON.stringify(email ? { email } : {}),
        });
    },

    async getSeries(username: string): Promise<any> {
        return apiFetch(`/${username}/series`);
    },

    async getSeriesBooks(username: string, name: string): Promise<any> {
        return apiFetch(`/${username}/series/${encodeURIComponent(name)}`);
    },

    async searchMetadata(username: string, query: string, source: string = 'google'): Promise<any> {
        return apiFetch(`/${username}/metadata/search`, {
            method: 'POST',
            body: JSON.stringify({ query, source }),
        });
    },

    async uploadBook(username: string, file: File, metadata?: Record<string, any>): Promise<any> {
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

        const resp = await fetch(`${API_BASE}/${username}/books?${qs.toString()}`, {
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

    async downloadFile(username: string, bookId: number, title: string): Promise<void> {
        const resp = await apiFetchRaw(`/${username}/books/${bookId}/file`);
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
