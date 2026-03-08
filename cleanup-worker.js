const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const DVR_ROOT = workerData.DVR_ROOT;
let cameras = Array.isArray(workerData.cameras) ? workerData.cameras : [];

function cleanup() {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Iterate over cameras and remove video folders older than retentionDays
    for (const cam of cameras) {
        // Base directory for this camera
        const baseDir = path.join(DVR_ROOT, cam.name);
        // Convert retention to milliseconds
        const retentionMs = Number(cam.retentionDays) * DAY_MS;

        // Skip this camera if retentionDays is missing or invalid
        if (!Number.isFinite(retentionMs) || retentionMs < 0) continue;
        // Skip if the camera directory does not exist
        if (!fs.existsSync(baseDir)) continue;

        // Read first-level folders (days)
        const dayEntries = fs.readdirSync(baseDir, { withFileTypes: true });

        // First-level folders are days in YYYY-MM-DD format
        for (const dayEntry of dayEntries) {
            // Ensure this is a directory and its name matches the date format
            if (!dayEntry.isDirectory()) continue;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dayEntry.name)) continue;

            // Build day folder path and compute this day's end time in milliseconds
            const dayPath = path.join(baseDir, dayEntry.name);
            const dayEnd = new Date(`${dayEntry.name}T23:59:59.999`).getTime();
            
            // If day end time is valid and older than retention, remove the whole day folder
            if (Number.isFinite(dayEnd) && (now - dayEnd) > retentionMs) {
                fs.rmSync(dayPath, { recursive: true, force: true });
                continue;
            }

            // If the day folder was not removed, check nested hour folders
            const hourEntries = fs.readdirSync(dayPath, { withFileTypes: true });

            // Second-level folders are hours in HH format
            for (const hourEntry of hourEntries) {
                // Ensure this is a directory and its name matches the hour format
                if (!hourEntry.isDirectory()) continue;
                if (!/^\d{2}$/.test(hourEntry.name)) continue;

                // Build hour folder path and compute this hour's end time in milliseconds
                const hourPath = path.join(dayPath, hourEntry.name);
                const hourEnd = new Date(
                    `${dayEntry.name}T${hourEntry.name}:59:59.999`
                ).getTime();
                // If hour end time is valid and older than retention, remove the hour folder
                if (Number.isFinite(hourEnd) && (now - hourEnd) > retentionMs) {
                    fs.rmSync(hourPath, { recursive: true, force: true });
                }
            }
        }
    }
}

parentPort.on('message', (msg) => {
    if (!msg || !msg.type) return;

    // If updated camera config is received, keep it for upcoming cleanup runs
    if (msg.type === 'updateConfig') {
        if (Array.isArray(msg.cameras)) {
            cameras = msg.cameras;
        }
        return;
    }
    
    // If a cleanup command is received, run cleanup
    if (msg.type !== 'run') return;

    try {
        cleanup();
        parentPort.postMessage({ type: 'done' });
    } catch (err) {
        parentPort.postMessage({
            type: 'error',
            error: err && err.message ? err.message : String(err)
        });
    }
});
