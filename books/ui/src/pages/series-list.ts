import { api } from '../api';
import { getLibraryUsername } from '../context';
import { navigate } from '../router';

export async function renderSeriesList(): Promise<void> {
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
        const data = await api.getSeries(username);
        const series: any[] = data.series;

        if (series.length === 0) {
            app.innerHTML = `
                <div class="text-center text-muted py-5">
                    <i class="bi bi-collection" style="font-size: 3rem;"></i>
                    <p class="mt-2">No series found</p>
                </div>
            `;
            return;
        }

        let html = `<h4 class="mb-3">${series.length} Series</h4>`;
        html += '<div class="row g-3">';

        for (const s of series) {
            const pct = s.total_books > 0
                ? Math.round((s.read_count / s.total_books) * 100)
                : 0;
            const avgRating = s.avg_rating
                ? s.avg_rating.toFixed(1)
                : '-';

            html += `
                <div class="col-12 col-sm-6 col-md-4 col-lg-3">
                    <div class="card series-card h-100" data-series="${escapeAttr(s.series)}">
                        <div class="card-body">
                            <h6 class="card-title mb-1">${escapeHtml(s.series)}</h6>
                            <div class="d-flex justify-content-between text-muted small mb-2">
                                <span>${s.total_books} book${s.total_books !== 1 ? 's' : ''}</span>
                                <span>${s.read_count}/${s.total_books} read</span>
                            </div>
                            <div class="progress series-progress mb-2">
                                <div class="progress-bar bg-success" style="width: ${pct}%"></div>
                            </div>
                            <div class="text-muted small">
                                Avg rating: ${avgRating}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        html += '</div>';
        app.innerHTML = html;

        // Attach click handlers
        app.querySelectorAll('.series-card').forEach(card => {
            card.addEventListener('click', () => {
                const name = card.getAttribute('data-series');
                if (name) navigate(`#/series/${encodeURIComponent(name)}`);
            });
        });
    } catch (err: any) {
        app.innerHTML = `
            <div class="alert alert-danger">
                Failed to load series: ${err.message}
            </div>
        `;
    }
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text: string): string {
    return text.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
