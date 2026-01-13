const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');

function getLocalDateStr(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

let mainWindow;
let tray;
let isQuitting = false;

// Tracking State
let trackingData = {
    // Current session
    currentSessionStart: null,

    // Today's accumulated data
    sessions: [], // Array of { start: ISO, end: ISO, duration: seconds }

    // Track which date these sessions belong to
    currentDate: getLocalDateStr(),

    // Status
    status: 'Initializing',
    isTracking: false,
    lastActiveTime: Date.now(),

    // Notification flags for today
    notificationsSent: {
        h6: false,
        h8: false,
        h10: false
    }
};

// Logging to Documents for easier access
const LOG_FILE = path.join(app.getPath('documents'), 'time-tracker-debug.txt');

function log(msg) {
    try {
        const timestamp = new Date().toLocaleString();
        fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
    } catch (e) {
        console.error('Logging failed:', e);
    }
}

// Store data in userData directory
const DATA_FILE = path.join(app.getPath('userData'), 'time-tracker-data.json');

// Helper to load data
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            const today = getLocalDateStr();

            // Set current date on load
            trackingData.currentDate = today;

            // Load today's sessions if they exist
            const todayData = data[today];
            if (todayData && typeof todayData === 'object' && todayData.sessions) {
                trackingData.sessions = todayData.sessions;
            } else {
                trackingData.sessions = [];
            }
            log(`App Clean Start. Loaded ${trackingData.sessions.length} sessions for today (${today}).`);
        }
    } catch (e) {
        log(`Failed to load data: ${e.message}`);
    }
}

// Helper to save data
function saveData() {
    try {
        let allData = {};
        if (fs.existsSync(DATA_FILE)) {
            try {
                allData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            } catch (readErr) {
                log(`Error reading existing data file, creating new: ${readErr.message}`);
            }
        }

        // Use the tracked date, not necessarily "now" (in case of midnight crossover save)
        const dateKey = trackingData.currentDate;

        // Calculate total for summary (purely for JSON readability)
        const totalSecs = trackingData.sessions.reduce((acc, s) => acc + s.duration, 0);

        allData[dateKey] = {
            total: totalSecs,
            sessions: trackingData.sessions
        };

        fs.writeFileSync(DATA_FILE, JSON.stringify(allData, null, 2));
    } catch (e) {
        log(`Failed to save data: ${e.message}`);
    }
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show App', click: () => mainWindow.show() },
        { type: 'separator' },
        {
            label: 'Quit', click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('Time Tracker');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => mainWindow.show());
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 400,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        backgroundColor: '#1a1a1a',
        icon: path.join(__dirname, 'icon.png'),
        title: `Time Tracker v${app.getVersion()}`
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Minimize to tray logic
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
            return false;
        }
    });
}

// --- Tracking Logic ---

// Check if Chrome is running
function isChromeRunning() {
    return new Promise((resolve) => {
        exec('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', (err, stdout) => {
            if (err) {
                resolve(false);
                return;
            }
            resolve(stdout.toLowerCase().includes('chrome.exe'));
        });
    });
}

// Fallback Idle Check using PowerShell
function getIdleTimePs() {
    return new Promise((resolve) => {
        let psPath = path.join(__dirname, 'idle.ps1');

        // Fix for ASAR: If running in asar, the script is in app.asar.unpacked
        if (psPath.includes('app.asar')) {
            psPath = psPath.replace('app.asar', 'app.asar.unpacked');
        }

        exec(`powershell -ExecutionPolicy Bypass -File "${psPath}"`, (err, stdout, stderr) => {
            if (err) {
                log(`PS Error: ${err.message}`);
                resolve(0);
                return;
            }
            const output = stdout.trim();
            const millis = parseInt(output);
            resolve(isNaN(millis) ? 0 : millis / 1000);
        });
    });
}

// Check idle time using desktop-idle with fallback
let useFallback = false;
let desktopIdle;

try {
    desktopIdle = require('desktop-idle');
} catch (e) {
    console.warn('desktop-idle not found, switching to PowerShell fallback.');
    useFallback = true;
}

async function getIdleTime() {
    if (useFallback) {
        return await getIdleTimePs();
    } else {
        try {
            return desktopIdle.getIdleTime();
        } catch (e) {
            console.error('desktop-idle runtime error, switching to fallback:', e);
            useFallback = true;
            return await getIdleTimePs();
        }
    }
}

// Concurrency Lock
let isChecking = false;

async function checkActivity() {
    if (isChecking) return;
    isChecking = true;

    try {
        // 1. Check for Date Rollover (Midnight)
        const todayStr = getLocalDateStr();

        if (todayStr !== trackingData.currentDate) {
            log(`Midnight Rollover Triggered: ${trackingData.currentDate} -> ${todayStr}`);

            // Force save current state to OLD date
            // If currently tracking, split the session
            if (trackingData.isTracking && trackingData.currentSessionStart) {
                const currentSessionEnd = Date.now();
                const duration = Math.floor((currentSessionEnd - trackingData.currentSessionStart) / 1000);

                if (duration > 0) {
                    trackingData.sessions.push({
                        start: new Date(trackingData.currentSessionStart).toISOString(),
                        end: new Date(currentSessionEnd).toISOString(),
                        duration: duration
                    });
                }
                saveData(); // Save to OLD date
                log(`Saved split session to ${trackingData.currentDate}. Duration: ${duration}s`);
            } else {
                saveData(); // Save whatever we had
                log(`Saved final state for ${trackingData.currentDate}.`);
            }

            // --- CRITICAL RESET ---
            trackingData.sessions = [];
            trackingData.currentDate = todayStr;
            trackingData.notificationsSent = { h6: false, h8: false, h10: false };

            // If we were tracking, restart the "current session" for the new day
            if (trackingData.isTracking) {
                trackingData.currentSessionStart = Date.now();
                log(`Auto-started new session for ${todayStr}.`);
            }
            // ----------------------
        }

        const chromeOpen = await isChromeRunning();
        const idleSeconds = await getIdleTime();

        // Logic: Working if Chrome is Open AND Idle < 120 seconds
        const isWorking = chromeOpen && (idleSeconds < 120);

        if (isWorking) {
            // State transition: Not Tracking -> Tracking
            if (!trackingData.isTracking) {
                trackingData.isTracking = true;
                trackingData.currentSessionStart = Date.now();
                log('Started tracking session (Active)');
            }

            trackingData.status = 'Tracking (Working)';
            trackingData.lastActiveTime = Date.now();

        } else {
            // State transition: Tracking -> Not Tracking
            if (trackingData.isTracking) {
                trackingData.isTracking = false;

                // Commit session
                if (trackingData.currentSessionStart) {
                    const nowTimestamp = Date.now();
                    const duration = Math.floor((nowTimestamp - trackingData.currentSessionStart) / 1000);

                    // Only save meaningful sessions (> 1 second)
                    if (duration > 0) {
                        trackingData.sessions.push({
                            start: new Date(trackingData.currentSessionStart).toISOString(),
                            end: new Date(nowTimestamp).toISOString(),
                            duration: duration
                        });
                        saveData(); // Save immediately on pause
                    }
                    trackingData.currentSessionStart = null;
                    log(`Ended session. Duration: ${duration}s`);
                }
            }

            if (!chromeOpen) {
                trackingData.status = 'Paused (Chrome Closed)';
            } else {
                trackingData.status = 'Paused (Idle)';
            }
        }

        // Update Last Active Display
        let displayLastActive = isWorking ? Date.now() : (Date.now() - (idleSeconds * 1000));
        trackingData.lastActiveTime = displayLastActive;


        // Calculate Total Seconds for Display
        // Robust logic: Count only the seconds that overlap with "Today" (Local Time)
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 00:00:00 Local
        const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000); // 00:00:00 Next Day

        let totalSecondsCalculated = 0;

        // Sum up completed sessions
        trackingData.sessions.forEach(s => {
            const sStart = new Date(s.start);
            const sEnd = new Date(s.end);

            // Calculate overlap with today
            const overlapStart = sStart < startOfDay ? startOfDay : sStart;
            const overlapEnd = sEnd > endOfDay ? endOfDay : sEnd;

            if (overlapStart < overlapEnd) {
                totalSecondsCalculated += Math.floor((overlapEnd - overlapStart) / 1000);
            }
        });

        // Add current ongoing session
        if (trackingData.isTracking && trackingData.currentSessionStart) {
            const currentStart = new Date(trackingData.currentSessionStart);
            const currentNow = new Date();

            const overlapStart = currentStart < startOfDay ? startOfDay : currentStart;
            const overlapEnd = currentNow > endOfDay ? endOfDay : currentNow;

            if (overlapStart < overlapEnd) {
                totalSecondsCalculated += Math.floor((overlapEnd - overlapStart) / 1000);
            }
        }

        // Check Notifications (6h=21600, 8h=28800, 10h=36000)
        if (!trackingData.notificationsSent.h6 && totalSecondsCalculated >= 21600) {
            new Notification({ title: 'Time Tracker', body: 'You have worked 6 hours today!' }).show();
            trackingData.notificationsSent.h6 = true;
            log('Sent 6h notification');
        }
        if (!trackingData.notificationsSent.h8 && totalSecondsCalculated >= 28800) {
            new Notification({ title: 'Time Tracker', body: 'You have worked 8 hours today!' }).show();
            trackingData.notificationsSent.h8 = true;
            log('Sent 8h notification');
        }
        if (!trackingData.notificationsSent.h10 && totalSecondsCalculated >= 36000) {
            new Notification({ title: 'Time Tracker', body: 'You have worked 10 hours today!' }).show();
            trackingData.notificationsSent.h10 = true;
            log('Sent 10h notification');
        }

        // Update UI
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-time', {
                totalSeconds: totalSecondsCalculated,
                status: trackingData.status,
                isTracking: trackingData.isTracking,
                lastActiveTime: trackingData.lastActiveTime,
                currentDate: trackingData.currentDate,
                version: app.getVersion()
            });
        }

    } catch (err) {
        log(`CRITICAL ERROR in checkActivity: ${err.message}\n${err.stack}`);
    } finally {
        isChecking = false;
    }
}

// --- App Lifecycle ---

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        log('App starting...');
        loadData();
        createWindow();
        createTray();

        ipcMain.handle('get-history', async () => {
            try {
                if (fs.existsSync(DATA_FILE)) {
                    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                }
                return {};
            } catch (e) {
                log('Failed to read history IPC');
                return {};
            }
        });

        ipcMain.handle('get-startup-status', () => {
            const settings = app.getLoginItemSettings();
            return settings.openAtLogin;
        });

        ipcMain.handle('toggle-startup', (event, enable) => {
            app.setLoginItemSettings({
                openAtLogin: enable,
                path: app.getPath('exe')
            });
            return app.getLoginItemSettings().openAtLogin;
        });

        setInterval(() => {
            checkActivity();
        }, 1000);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

// Ensure we save data before quitting
app.on('will-quit', () => {
    log('App is quitting, saving data...');
    if (trackingData.isTracking && trackingData.currentSessionStart) {
        const nowTimestamp = Date.now();
        const duration = Math.floor((nowTimestamp - trackingData.currentSessionStart) / 1000);

        if (duration > 0) {
            trackingData.sessions.push({
                start: new Date(trackingData.currentSessionStart).toISOString(),
                end: new Date(nowTimestamp).toISOString(),
                duration: duration
            });
            log(`Saved final session on quit. Duration: ${duration}s`);
        }
    }
    saveData();
});

app.on('window-all-closed', () => {
    // Keep running
});
