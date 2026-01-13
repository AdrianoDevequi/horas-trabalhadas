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

const LOG_FILE = path.join(app.getPath('userData'), 'debug-log.txt');
function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {
        // ignore
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

            // Handle legacy format (backward compatibility-ish) or new format
            const todayData = data[today];
            if (todayData && typeof todayData === 'object' && todayData.sessions) {
                trackingData.sessions = todayData.sessions;
            } else if (todayData && typeof todayData === 'number') {
                // If we have legacy seconds, maybe convert to a dummy session? 
                // For simplicity, let's just ignore or reset for now as user requested new format
                trackingData.sessions = [];
            } else {
                trackingData.sessions = [];
            }
            console.log(`Loaded ${trackingData.sessions.length} sessions for today (${today}).`);
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
            allData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }

        // Use the tracked date, not necessarily "now" (in case of midnight crossover save)
        const dateKey = trackingData.currentDate;

        // Calculate total for summary
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
        icon: path.join(__dirname, 'icon.png')
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
                console.error(err);
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
                log(`PS Stderr: ${stderr}`);
                resolve(0);
                return;
            }
            const output = stdout.trim();
            const millis = parseInt(output);

            // log(`PS Path: ${psPath}, Output: ${output}`); // Uncomment for verbose logs if needed

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

async function checkActivity() {
    // 1. Check for Date Rollover (Midnight)
    const todayStr = getLocalDateStr();

    if (todayStr !== trackingData.currentDate) {
        log(`Midnight rollover detected: ${trackingData.currentDate} -> ${todayStr}`);

        // If currently tracking, we need to split the session
        if (trackingData.isTracking && trackingData.currentSessionStart) {
            const currentSessionEnd = Date.now();
            const duration = Math.floor((currentSessionEnd - trackingData.currentSessionStart) / 1000);

            // Save the session to the OLD day
            if (duration > 0) {
                trackingData.sessions.push({
                    start: new Date(trackingData.currentSessionStart).toISOString(),
                    end: new Date(currentSessionEnd).toISOString(),
                    duration: duration
                });
            }
            saveData(); // Saves to trackingData.currentDate (yesterday)

            // Start fresh for NEW day
            trackingData.sessions = [];
            trackingData.currentDate = todayStr;
            trackingData.currentSessionStart = Date.now(); // Continue tracking immediately

            // Reset notifications
            trackingData.notificationsSent = { h6: false, h8: false, h10: false };

            log(`Session split across midnight. Continuing tracking for ${todayStr}.`);
        } else {
            // Not tracking, just switch days
            saveData(); // Save whatever we had for yesterday
            trackingData.sessions = [];
            trackingData.currentDate = todayStr;

            // Reset notifications
            trackingData.notificationsSent = { h6: false, h8: false, h10: false };

            log(`Switched to new day: ${todayStr}`);
        }
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
            log('Started tracking session');
        }

        trackingData.status = 'Tracking (Working)';
        trackingData.lastActiveTime = Date.now(); // Update active time continuously while working

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

    // data.lastActiveTime is set above if working. 
    // If not working, it retains the last timestamp from when it Was working.
    // However, if we just rely on that, it might be old.
    // The user wants "time of last interaction".
    // If idleSeconds < 120, interaction IS happening (or happened recently).
    // If idleSeconds > 120, interaction happened (Now - idleSeconds).

    // Let's refine lastActiveTime logic for UI display:
    // If isWorking, lastActive is Now.
    // If not working (idle), lastActive is Now - idleSeconds*1000.
    // Use this calculated value for cleaner UI?
    // Actually, let's trust the `idleSeconds` calculation.
    let displayLastActive = isWorking ? Date.now() : (Date.now() - (idleSeconds * 1000));
    trackingData.lastActiveTime = displayLastActive;


    // Calculate Total Seconds for Display
    // Robust logic: Count only the seconds that overlap with "Today" (Local Time)
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 00:00:00 Local
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000); // 00:00:00 Next Day

    // DEBUG LOG
    const debugPath = path.join(__dirname, 'debug-calc.txt');
    try {
        fs.writeFileSync(debugPath, `Calc Debug at ${now.toISOString()}\nStartOfDay: ${startOfDay.toISOString()}\n`);
    } catch (e) { }

    let totalSecondsFunc = trackingData.sessions.reduce((acc, s) => {
        const sStart = new Date(s.start);
        const sEnd = new Date(s.end);

        // Calculate overlap with today
        const overlapStart = sStart < startOfDay ? startOfDay : sStart;
        const overlapEnd = sEnd > endOfDay ? endOfDay : sEnd;

        let duration = 0;
        if (overlapStart < overlapEnd) {
            duration = Math.floor((overlapEnd - overlapStart) / 1000);
        }

        try {
            fs.appendFileSync(debugPath, `Session: ${s.start} -> ${s.end} | Overlap: ${overlapStart.toISOString()} -> ${overlapEnd.toISOString()} | Dur: ${duration}\n`);
        } catch (e) { }

        return acc + duration;
    }, 0);

    // Add current session if tracking
    if (trackingData.isTracking && trackingData.currentSessionStart) {
        const currentStart = new Date(trackingData.currentSessionStart);
        const currentNow = new Date(); // roughly now

        const overlapStart = currentStart < startOfDay ? startOfDay : currentStart;
        const overlapEnd = currentNow > endOfDay ? endOfDay : currentNow;

        if (overlapStart < overlapEnd) {
            totalSecondsFunc += Math.floor((overlapEnd - overlapStart) / 1000);
        }
    }

    // Check Notifications (6h=21600, 8h=28800, 10h=36000)
    if (!trackingData.notificationsSent.h6 && totalSecondsFunc >= 21600) {
        new Notification({ title: 'Time Tracker', body: 'You have worked 6 hours today!' }).show();
        trackingData.notificationsSent.h6 = true;
    }
    if (!trackingData.notificationsSent.h8 && totalSecondsFunc >= 28800) {
        new Notification({ title: 'Time Tracker', body: 'You have worked 8 hours today!' }).show();
        trackingData.notificationsSent.h8 = true;
    }
    if (!trackingData.notificationsSent.h10 && totalSecondsFunc >= 36000) {
        new Notification({ title: 'Time Tracker', body: 'You have worked 10 hours today!' }).show();
        trackingData.notificationsSent.h10 = true;
    }

    // Update UI
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-time', {
            totalSeconds: totalSecondsFunc,
            status: trackingData.status,
            isTracking: trackingData.isTracking,
            lastActiveTime: trackingData.lastActiveTime,
            currentDate: trackingData.currentDate // checking UI consistency
        });
    }
}

// --- App Lifecycle ---

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    // Start app
    app.whenReady().then(() => {
        loadData();
        createWindow();
        createTray();

        // IPC to get history
        ipcMain.handle('get-history', async () => {
            try {
                if (fs.existsSync(DATA_FILE)) {
                    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                }
                return {};
            } catch (e) {
                console.error('Failed to read history:', e);
                return {};
            }
        });

        // Startup Settings
        ipcMain.handle('get-startup-status', () => {
            const settings = app.getLoginItemSettings();
            return settings.openAtLogin;
        });

        ipcMain.handle('toggle-startup', (event, enable) => {
            app.setLoginItemSettings({
                openAtLogin: enable,
                path: app.getPath('exe') // Optional, but good practice
            });
            return app.getLoginItemSettings().openAtLogin;
        });

        // Loop every 1 second
        setInterval(() => {
            checkActivity();
        }, 1000);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

app.on('window-all-closed', () => {
    // Do nothing, keep running in tray unless explicit quit
});
