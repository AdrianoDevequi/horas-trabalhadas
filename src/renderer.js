const timerElement = document.getElementById('timer-display');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');

function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

window.electronAPI.onUpdateTime((data) => {
    timerElement.textContent = formatTime(data.totalSeconds);
    statusText.textContent = data.status;

    // Update Last Interaction
    if (data.lastActiveTime) {
        const now = Date.now();
        const diffMs = now - data.lastActiveTime;
        const diffMins = Math.floor(diffMs / 60000);

        let timeAgoStr = diffMins < 1 ? 'Just now' : `${diffMins} min ago`;

        const date = new Date(data.lastActiveTime);
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        document.getElementById('last-interaction').textContent = `Last Interaction: ${timeStr} (${timeAgoStr})`;
    }

    // Update dot color class
    statusDot.className = 'dot'; // reset
    if (data.isTracking) {
        statusDot.classList.add('active');
    } else {
        if (data.status.includes('Idle')) {
            statusDot.classList.add('paused-idle');
        } else if (data.status.includes('Chrome')) {
            statusDot.classList.add('paused-chrome');
        }
    }

    // Update version if needed
    if (data.version) {
        const vEl = document.getElementById('app-version');
        if (vEl && vEl.textContent === '...') {
            vEl.textContent = data.version;
        }
        document.title = `Time Tracker v${data.version}`;
    }
});

// History Logic
const historyBtn = document.getElementById('history-btn');
const historyModal = document.getElementById('history-modal');
const closeHistoryBtn = document.getElementById('close-history');
const historyList = document.getElementById('history-list');

historyBtn.addEventListener('click', async () => {
    const history = await window.electronAPI.getHistory();
    renderHistory(history);
    historyModal.classList.remove('hidden');
});

closeHistoryBtn.addEventListener('click', () => {
    historyModal.classList.add('hidden');
});

function renderHistory(historyData) {
    historyList.innerHTML = '';

    // 1. Flatten and Regroup by Local Date
    const grouped = {};

    Object.values(historyData).forEach(dayData => {
        const sessions = dayData.sessions || [];
        sessions.forEach(session => {
            if (!session.start || !session.end) return;

            const startDate = new Date(session.start);
            // Get local YYYY-MM-DD
            const year = startDate.getFullYear();
            const month = String(startDate.getMonth() + 1).padStart(2, '0');
            const day = String(startDate.getDate()).padStart(2, '0');
            const localDateKey = `${year}-${month}-${day}`; // Format: YYYY-MM-DD

            if (!grouped[localDateKey]) {
                grouped[localDateKey] = { sessions: [], total: 0 };
            }
            grouped[localDateKey].sessions.push(session);
            grouped[localDateKey].total += session.duration;
        });
    });

    // Sort dates descending
    const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

    if (sortedDates.length === 0) {
        historyList.innerHTML = '<div style="text-align:center; color: #666; padding: 20px;">No history yet</div>';
        return;
    }

    sortedDates.forEach(date => {
        const dayData = grouped[date];
        const sessions = dayData.sessions || [];
        // Sort sessions by start time descending
        sessions.sort((a, b) => new Date(b.start) - new Date(a.start));

        const total = dayData.total || 0;

        const dayContainer = document.createElement('div');
        dayContainer.className = 'history-day-block';

        // Header: Date
        // Create date from YYYY-MM-DD local parts
        const [y, m, d] = date.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        const dateDisplay = dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

        let html = `<div class="day-header">${dateDisplay}</div>`;

        // Sessions
        sessions.forEach(session => {
            const start = new Date(session.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(session.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            // Format duration: X min
            const durMins = Math.ceil(session.duration / 60);

            html += `
                <div class="session-row">
                    <span class="session-time">${start} - ${end}</span>
                    <span class="session-dur">${durMins}min</span>
                </div>
            `;
        });

        // Footer: Total
        const totalMins = Math.floor(total / 60);
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;

        let totalDisplay = `${totalMins}min`;
        if (hours > 0) {
            totalDisplay = `${hours}h ${mins}min`;
        }

        html += `
            <div class="day-total">
                <span>Total:</span>
                <span>${totalDisplay}</span>
            </div>
        `;

        dayContainer.innerHTML = html;
        historyList.appendChild(dayContainer);
    });
}

// --- Settings Logic ---
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings');
const startupToggle = document.getElementById('startup-toggle');

settingsBtn.addEventListener('click', async () => {
    // Get current status
    const isEnabled = await window.electronAPI.getStartupStatus();
    startupToggle.checked = isEnabled;
    settingsModal.classList.remove('hidden');
});

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
});

startupToggle.addEventListener('change', async (e) => {
    const newVal = e.target.checked;
    await window.electronAPI.toggleStartup(newVal);
});
