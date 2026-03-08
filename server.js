const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DVR_ROOT = '/var/dvr';
const FFMPEG_RESTART_DELAY_MS = 5000;
const CAMERA_STOP_TIMEOUT_MS = 3000;

const PREVIEW_DURATION = 0.2; // seconds
const PREVIEW_CHECK_INTERVAL = 15000; // check every 15 seconds

const app = express();

let config = loadConfigFromDisk();
let segmentDuration = config.segmentDuration;
let liveSegments = config.liveWindow;
let cleanupIntervalMs = config.cleanupIntervalMinutes * 60 * 1000;

const cameraRuntimes = new Map(); // ffmpeg runtime per camera
let cleanupWorker = null;
let cleanupInProgress = false;
let cleanupTimer = null;
let isShuttingDown = false;
let reloadInProgress = false;
let reloadQueued = false;

// ----------------------------------------
// Config
// ----------------------------------------
function normalizeConfig(rawConfig) {
    if (!rawConfig || typeof rawConfig !== 'object') {
        throw new Error('Config must be an object');
    }

    const nextSegmentDuration = Number(rawConfig.segmentDuration);
    const nextLiveWindow = Math.floor(Number(rawConfig.liveWindow));
    const nextCleanupIntervalMinutes = Number(rawConfig.cleanupIntervalMinutes);

    if (!Number.isFinite(nextSegmentDuration) || nextSegmentDuration <= 0) {
        throw new Error('segmentDuration must be a positive number');
    }

    if (!Number.isFinite(nextLiveWindow) || nextLiveWindow <= 0) {
        throw new Error('liveWindow must be a positive integer');
    }

    if (!Number.isFinite(nextCleanupIntervalMinutes) || nextCleanupIntervalMinutes <= 0) {
        throw new Error('cleanupIntervalMinutes must be a positive number');
    }

    if (!Array.isArray(rawConfig.cameras)) {
        throw new Error('cameras must be an array');
    }

    const seenNames = new Set();
    const cameras = rawConfig.cameras.map((camera, index) => {
        if (!camera || typeof camera !== 'object') {
            throw new Error(`cameras[${index}] must be an object`);
        }

        const name = typeof camera.name === 'string' ? camera.name.trim() : '';
        const rtsp = typeof camera.rtsp === 'string' ? camera.rtsp.trim() : '';

        if (!name) {
            throw new Error(`cameras[${index}].name is required`);
        }

        if (seenNames.has(name)) {
            throw new Error(`duplicate camera name: ${name}`);
        }
        seenNames.add(name);

        if (!rtsp) {
            throw new Error(`cameras[${index}].rtsp is required`);
        }

        return {
            ...camera,
            name,
            rtsp,
            disableAudio: camera.disableAudio === true
        };
    });

    return {
        ...rawConfig,
        segmentDuration: nextSegmentDuration,
        liveWindow: nextLiveWindow,
        cleanupIntervalMinutes: nextCleanupIntervalMinutes,
        cameras
    };
}

function loadConfigFromDisk() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
}

// ----------------------------------------
// Ensure DVR directories exist
// ----------------------------------------
function ensureCameraDirs(cameras = config.cameras) {
    if (!fs.existsSync(DVR_ROOT)) {
        fs.mkdirSync(DVR_ROOT, { recursive: true });
    }

    for (const cam of cameras) {
        const dir = path.join(DVR_ROOT, cam.name);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

function cameraRequiresRestart(prevCamera, nextCamera) {
    return (
        prevCamera.rtsp !== nextCamera.rtsp ||
        prevCamera.disableAudio !== nextCamera.disableAudio
    );
}

function buildFfmpegArgs(camera) {
    const outputDir = path.join(DVR_ROOT, camera.name);

    const args = [
        '-rtsp_transport', 'tcp',
        '-i', camera.rtsp
    ];

    // If audio is disabled in config
    if (camera.disableAudio === true) {
        args.push('-an');
    }

    // Always copy video
    args.push(
        '-c:v', 'copy'
    );

    // If audio is not disabled, copy it as-is
    if (camera.disableAudio !== true) {
        args.push('-c:a', 'copy');
    }

    args.push(
        '-f', 'hls',
        '-hls_time', segmentDuration.toString(),
        '-hls_segment_type', 'fmp4',
        '-hls_playlist_type', 'event',
        '-strftime', '1',
        '-strftime_mkdir', '1',
        '-hls_segment_filename', `${outputDir}/%Y-%m-%d/%H/%Y%m%d_%H%M%S.m4s`,
        `${outputDir}/index.m3u8`
    );

    return args;
}

function registerCameraRuntime(camera) {
    cameraRuntimes.set(camera.name, {
        camera,
        process: null,
        shouldRun: true,
        restartTimer: null
    });
}

// ----------------------------------------
// Start/stop FFmpeg
// ----------------------------------------
function startCameraProcess(cameraName) {
    const runtime = cameraRuntimes.get(cameraName);
    if (!runtime || !runtime.shouldRun || runtime.process) return;

    const args = buildFfmpegArgs(runtime.camera);

    console.log(`Starting ffmpeg for ${cameraName}`);
    console.log('Args:', args.join(' '));

    const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
    runtime.process = ff;

    ff.on('exit', (code, signal) => {
        const current = cameraRuntimes.get(cameraName);
        if (!current) return;

        current.process = null;

        if (!current.shouldRun || isShuttingDown) return;

        const exitReason = code === null ? `signal ${signal}` : `code ${code}`;
        console.log(`${cameraName} ffmpeg exited (${exitReason}), restarting...`);

        if (current.restartTimer) {
            clearTimeout(current.restartTimer);
        }

        current.restartTimer = setTimeout(() => {
            const latest = cameraRuntimes.get(cameraName);
            if (!latest || !latest.shouldRun || latest.process || isShuttingDown) return;
            latest.restartTimer = null;
            startCameraProcess(cameraName);
        }, FFMPEG_RESTART_DELAY_MS);
    });

    ff.on('error', (err) => {
        console.error(`Failed to start ffmpeg for ${cameraName}:`, err.message);
    });
}

function waitForProcessExit(proc, timeoutMs = CAMERA_STOP_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let done = false;

        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            proc.removeListener('exit', finish);
            resolve();
        };

        const timer = setTimeout(finish, timeoutMs);
        proc.once('exit', finish);
    });
}

async function stopCameraProcess(cameraName, { removeRuntime = false } = {}) {
    const runtime = cameraRuntimes.get(cameraName);
    if (!runtime) return;

    runtime.shouldRun = false;

    if (runtime.restartTimer) {
        clearTimeout(runtime.restartTimer);
        runtime.restartTimer = null;
    }

    const proc = runtime.process;
    runtime.process = null;

    if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        await waitForProcessExit(proc);
    }

    if (removeRuntime) {
        cameraRuntimes.delete(cameraName);
    }
}

async function restartCameraProcess(cameraName, reason) {
    const runtime = cameraRuntimes.get(cameraName);
    if (!runtime) return;

    console.log(`Restarting ffmpeg for ${cameraName}: ${reason}`);
    await stopCameraProcess(cameraName);
    runtime.shouldRun = true;
    startCameraProcess(cameraName);
}

async function reconcileCameraProcesses(previousConfig, nextConfig) {
    const previousNames = new Set(previousConfig.cameras.map((cam) => cam.name));
    const nextByName = new Map(nextConfig.cameras.map((cam) => [cam.name, cam]));
    const segmentDurationChanged = previousConfig.segmentDuration !== nextConfig.segmentDuration;

    for (const cameraName of previousNames) {
        if (nextByName.has(cameraName)) continue;

        console.log(`Camera removed from config: ${cameraName}`);
        await stopCameraProcess(cameraName, { removeRuntime: true });
    }

    for (const [cameraName, nextCamera] of nextByName.entries()) {
        const runtime = cameraRuntimes.get(cameraName);

        if (!runtime) {
            registerCameraRuntime(nextCamera);
            startCameraProcess(cameraName);
            continue;
        }

        const cameraChanged = cameraRequiresRestart(runtime.camera, nextCamera);
        runtime.camera = nextCamera;
        runtime.shouldRun = true;

        if (segmentDurationChanged || cameraChanged) {
            const reason = segmentDurationChanged
                ? 'segmentDuration changed'
                : 'camera RTSP/audio settings changed';
            await restartCameraProcess(cameraName, reason);
            continue;
        }

        if (!runtime.process) {
            startCameraProcess(cameraName);
        }
    }
}

function scheduleCleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
    }

    cleanupTimer = setInterval(runCleanup, cleanupIntervalMs);
}

async function applyConfig(nextConfig, trigger) {
    const previousConfig = config;
    const previousCleanupIntervalMs = cleanupIntervalMs;

    config = nextConfig;
    segmentDuration = nextConfig.segmentDuration;
    liveSegments = nextConfig.liveWindow;
    cleanupIntervalMs = nextConfig.cleanupIntervalMinutes * 60 * 1000;

    ensureCameraDirs(config.cameras);
    await reconcileCameraProcesses(previousConfig, nextConfig);

    if (cleanupIntervalMs !== previousCleanupIntervalMs) {
        scheduleCleanup();
    }

    syncCleanupConfig();

    console.log(
        `Config reloaded (${trigger}): ${config.cameras.length} camera(s), ` +
        `segmentDuration=${segmentDuration}, liveWindow=${liveSegments}, ` +
        `cleanupIntervalMinutes=${config.cleanupIntervalMinutes}`
    );
}

async function reloadConfig(trigger = 'manual') {
    if (reloadInProgress) {
        reloadQueued = true;
        return { ok: true, queued: true };
    }

    reloadInProgress = true;

    try {
        const nextConfig = loadConfigFromDisk();
        await applyConfig(nextConfig, trigger);
        return { ok: true, queued: false };
    } catch (err) {
        const errorMessage = err && err.message ? err.message : String(err);
        console.error(`Failed to reload config (${trigger}):`, errorMessage);
        return { ok: false, queued: false, error: errorMessage };
    } finally {
        reloadInProgress = false;

        if (reloadQueued && !isShuttingDown) {
            reloadQueued = false;
            reloadConfig('queued-change').catch(() => {});
        }
    }
}

function watchConfigFile() {
    fs.watchFile(CONFIG_PATH, { interval: 2000 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs) return;
        if (isShuttingDown) return;

        console.log('Detected config.json change, reloading...');
        reloadConfig('file-change').catch(() => {});
    });
}

// ----------------------------------------
// Converts filename like "20240101_123456.m4s" to a Date object
// ----------------------------------------
function parseTimestamp(filename) {
  const m = filename.match(/(\d{8})_(\d{6})\.m4s$/i);
  if (!m) throw new Error(`Bad filename format: ${filename}`);

  const [, date, time] = m;
  return new Date(
    `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T` +
    `${time.slice(0,2)}:${time.slice(2,4)}:${time.slice(4,6)}`
  );
}

// ----------------------------------------
// Select segments for a camera between startDate and endDate
// ----------------------------------------
function selectSegments(camera, startDate, endDate) {
    const segments = getSegments(camera);

    return segments.filter(f => {
        const ts = parseTimestamp(path.basename(f));
        return ts >= startDate && ts <= endDate;
    });
}

// ----------------------------------------
// Cleanup
// ----------------------------------------

// ----------------------------------------
// Initialize cleanup worker thread
// ----------------------------------------
function initCleanupWorker() {
    cleanupWorker = new Worker(path.join(__dirname, 'cleanup-worker.js'), {
        workerData: {
            DVR_ROOT,
            cameras: config.cameras
        }
    });

    cleanupWorker.on('message', (msg) => {
        if (!msg || !msg.type) return;

        if (msg.type === 'done') {
            cleanupInProgress = false;
            return;
        }

        if (msg.type === 'error') {
            cleanupInProgress = false;
            console.error('Cleanup worker error:', msg.error);
        }
    });

    cleanupWorker.on('error', (err) => {
        cleanupInProgress = false;
        console.error('Cleanup worker crashed:', err);
    });

    cleanupWorker.on('exit', (code) => {
        cleanupInProgress = false;
        if (!isShuttingDown && code !== 0) {
            console.error(`Cleanup worker exited with code ${code}, restarting...`);
            initCleanupWorker();
        }
    });

    syncCleanupConfig();
}

// ----------------------------------------
// Get latest cameras config for cleanup worker
// ----------------------------------------
function getLatestCleanupCameras() {
    return config.cameras;
}

// ----------------------------------------
// Sends updated config to cleanup worker in case cameras were changed in config.json
// ----------------------------------------
function syncCleanupConfig() {
    if (!cleanupWorker) return;
    cleanupWorker.postMessage({
        type: 'updateConfig',
        cameras: getLatestCleanupCameras()
    });
}

// ----------------------------------------
// Runs cleanup if not already running. Cleanup worker will handle locking and prevent concurrent runs.
// ----------------------------------------
function runCleanup() {
    if (!cleanupWorker || cleanupInProgress) return;
    syncCleanupConfig();
    cleanupInProgress = true;
    cleanupWorker.postMessage({ type: 'run' });
}

// ----------------------------------------
// Get segments for a camera
// ----------------------------------------
function getSegments(camera) {

    const cameraPath = path.join(DVR_ROOT, camera);
    const results = [];

    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const full = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.m4s')) {
                // Store relative path
                results.push(path.relative(cameraPath, full));
            }
        }
    }

    walk(cameraPath);

    return results.sort();
}

// ----------------------------------------
// Playlist builder
// ----------------------------------------
function buildPlaylist(camera, segments, mode, mediaSequence = 0) {

    let header = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:${segmentDuration}
#EXT-X-MAP:URI="/dvr/${camera}/init.mp4"
`;

    if (mode === 'live') {
        header += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`;
    } else {
        header += `#EXT-X-PLAYLIST-TYPE:VOD\n`;
    }

    let body = segments.map(f =>
        `#EXTINF:${segmentDuration.toFixed(3)},\n/dvr/${camera}/${f}`
    ).join('\n');

    if (mode !== 'live') body += '\n#EXT-X-ENDLIST';

    return header + '\n' + body;
}

// ----------------------------------------
// Build recording ranges for status endpoint
// ----------------------------------------
function buildRecordingRanges(camera) {

    const segments = getSegments(camera);

    if (segments.length === 0) {
        return [];
    }
    const ranges = [];

    let currentStart = null;
    let previousTs = null;

    for (const file of segments) {

        const ts = parseTimestamp(path.basename(file));
        if (!ts || isNaN(ts)) continue;

        const unix = Math.floor(ts.getTime() / 1000);

        if (currentStart === null) {
            currentStart = unix;
            previousTs = unix;
            continue;
        }

        const gap = unix - previousTs;

        if (gap > segmentDuration * 1.5) {
            ranges.push({
                from: currentStart,
                duration: previousTs - currentStart + segmentDuration
            });

            currentStart = unix;
        }

        previousTs = unix;
    }

    // Close the last range
    if (currentStart !== null && previousTs !== null) {
        ranges.push({
            from: currentStart,
            duration: previousTs - currentStart + segmentDuration
        });
    }

    return ranges;
}

// ----------------------------------------
// Generate a preview for the camera every minute
// ----------------------------------------
function generateMinutePreview(cameraName) {

    const cameraPath = path.join(DVR_ROOT, cameraName);
    const segments = getSegments(cameraName);

    if (!segments.length) return;

    const lastSegmentRel = segments[segments.length - 1];
    const lastSegmentFull = path.join(cameraPath, lastSegmentRel);

    const baseName = path.basename(lastSegmentRel, '.m4s');
    const minuteKey = baseName.slice(0, 13); // YYYYMMDD_HHMM

    const previewName = `${minuteKey}_preview.mp4`;
    const previewFull = path.join(cameraPath, path.dirname(lastSegmentRel), previewName);

    if (fs.existsSync(previewFull)) return; // already exists

    const initPath = path.join(cameraPath, 'init.mp4');

    const ff = spawn('ffmpeg', [
        '-nostdin',
        '-threads', '1',
        '-loglevel', 'error',
        '-i', `concat:${initPath}|${lastSegmentFull}`,
        '-c', 'copy',
        '-t', PREVIEW_DURATION.toString(),
        '-an',
        '-movflags', '+faststart',
        previewFull
    ]);

    ff.on('error', () => {});
}

// ----------------------------------------
// Routes
// ----------------------------------------

// ----------------------------------------
// Live streaming HLS playlists
// ----------------------------------------
app.get([
    '/:camera/live.m3u8',
    '/:camera/index.m3u8',
    '/:camera/video.m3u8',
    '/:camera/live.fmp4.m3u8',
    '/:camera/index.fmp4.m3u8',
    '/:camera/video.fmp4.m3u8'], (req, res) => {

    const camera = req.params.camera;
    const segments = getSegments(camera);

    const live = segments.slice(-liveSegments);
    const mediaSequence = segments.length - live.length;

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');

    res.send(buildPlaylist(camera, live, 'live', mediaSequence));
});

// ----------------------------------------
// DVR archive HLS playlist for a given time and duration
// ----------------------------------------
app.get([
    '/:camera/dvr.m3u8',
    '/:camera/index-:timestamp-:duration.fmp4.m3u8',
    '/:camera/index-:timestamp-:duration.m3u8'], (req, res) => {

    const camera = req.params.camera;

    let start = null;
    let end = null;

    if (req.params.timestamp && req.params.duration) {

        const unix = parseInt(req.params.timestamp, 10);
        const dur = parseInt(req.params.duration, 10);

        if (isNaN(unix) || isNaN(dur)) {
            return res.status(400).send('Invalid timestamp');
        }

        start = new Date(unix * 1000);
        end = new Date((unix + dur) * 1000);
    } else if (!req.query.start || !req.query.end) {
        return res.status(400).send('start and end required');
    } else {
        start = new Date(req.query.start);
        end = new Date(req.query.end);
    }

    const selected = selectSegments(camera, start, end);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(buildPlaylist(camera, selected, 'vod'));
});

// ----------------------------------------
// DVR archive MP4 file download for a given time and duration
// ----------------------------------------
app.get('/:camera/archive-:from-:duration.mp4', (req, res) => {

    const camera = req.params.camera;
    const from = parseInt(req.params.from, 10);
    const duration = parseInt(req.params.duration, 10);

    if (isNaN(from) || isNaN(duration)) {
        return res.status(400).send('Invalid parameters');
    }

    const hlsUrl = `http://127.0.0.1:8080/${camera}/index-${from}-${duration}.fmp4.m3u8`;

    const tmpFile = `/tmp/archive_${camera}_${Date.now()}.mp4`;

    const ff = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-fflags', '+genpts',
        '-i', hlsUrl,
        '-c', 'copy',
        '-movflags', 'faststart',
        tmpFile
    ]);

    ff.on('close', () => {

        fs.stat(tmpFile, (err, stats) => {
            if (err) return res.status(500).send('Error');

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${camera}-${from}-${duration}.mp4"`
            );
            res.setHeader('Content-Length', stats.size);

            const stream = fs.createReadStream(tmpFile);
            stream.pipe(res);

            stream.on('close', () => {
                fs.unlink(tmpFile, () => {});
            });
        });
    });
});

// ----------------------------------------
// Endpoint with available time ranges
// ----------------------------------------
app.get('/:camera/recording_status.json', (req, res) => {

    const camera = req.params.camera;

    const exists = config.cameras.some(c => c.name === camera);
    if (!exists) {
        return res.status(404).json({ error: 'Camera not found' });
    }

    const ranges = buildRecordingRanges(camera);

    res.json([
        {
            stream: camera,
            ranges
        }
    ]);
});

// ----------------------------------------
// Endpoint to serve preview MP4 files.
// By default previews are generated every minute.
// ----------------------------------------
app.get('/:camera/:yyyy/:mm/:dd/:HH/:MM/:SS-preview.mp4', (req, res) => {

    const camera = req.params.camera;

    const yyyy = parseInt(req.params.yyyy, 10);
    const mm = parseInt(req.params.mm, 10);
    const dd = parseInt(req.params.dd, 10);
    const HH = parseInt(req.params.HH, 10);
    const MM = parseInt(req.params.MM, 10);
    const SS = parseInt(req.params.SS, 10);

    // Build date as UTC
    const utcDate = new Date(Date.UTC(yyyy, mm - 1, dd, HH, MM, SS));

    // Convert to server local time
    const localDate = new Date(utcDate.getTime());

    const localY = localDate.getFullYear();
    const localM = String(localDate.getMonth() + 1).padStart(2, '0');
    const localD = String(localDate.getDate()).padStart(2, '0');
    const localH = String(localDate.getHours()).padStart(2, '0');
    const localMin = String(localDate.getMinutes()).padStart(2, '0');

    const minuteKey = `${localY}${localM}${localD}_${localH}${localMin}`;
    const dayDir = `${localY}-${localM}-${localD}`;
    const hourDir = localH;

    const previewPath = path.join(
        DVR_ROOT,
        camera,
        dayDir,
        hourDir,
        `${minuteKey}_preview.mp4`
    );

    if (!fs.existsSync(previewPath)) {
        return res.status(404).send('Preview not found');
    }

    res.sendFile(previewPath);
});

async function handleConfigReloadRequest(req, res) {
    const result = await reloadConfig('http-endpoint');

    if (!result.ok) {
        return res.status(500).json(result);
    }

    res.json(result);
}

app.get('/admin/reload-config', handleConfigReloadRequest);
app.post('/admin/reload-config', handleConfigReloadRequest);

// ----------------------------------------
// Boot
// ----------------------------------------
ensureCameraDirs(config.cameras);

// Start ffmpeg for each camera
for (const cam of config.cameras) {
    registerCameraRuntime(cam);
    startCameraProcess(cam.name);
}

// Start worker to clean up old DVR files and previews
initCleanupWorker();
scheduleCleanup();
watchConfigFile();

// Check for new previews every 15 seconds
// while previews themselves are generated once per minute
setInterval(() => {
    for (const cam of config.cameras) {
        generateMinutePreview(cam.name);
    }
}, PREVIEW_CHECK_INTERVAL);

app.listen(3000, () => {
    console.log('DVR engine started');
});

function shutdown() {
    isShuttingDown = true;
    console.log('Shutting down DVR engine...');

    fs.unwatchFile(CONFIG_PATH);

    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }

    for (const [name, runtime] of cameraRuntimes.entries()) {
        runtime.shouldRun = false;

        if (runtime.restartTimer) {
            clearTimeout(runtime.restartTimer);
            runtime.restartTimer = null;
        }

        const proc = runtime.process;
        if (proc && !proc.killed) {
            console.log(`Stopping ffmpeg for ${name}`);
            proc.kill('SIGTERM');
        }
    }

    if (cleanupWorker) {
        cleanupWorker.terminate().catch(() => {});
    }

    setTimeout(() => {
        process.exit(0);
    }, 2000);
}

// Ctrl+C
process.on('SIGINT', shutdown);

// systemd / docker stop
process.on('SIGTERM', shutdown);

// Config reload without service restart
process.on('SIGHUP', () => {
    if (isShuttingDown) return;

    console.log('Received SIGHUP, reloading config...');
    reloadConfig('SIGHUP').catch(() => {});
});

// Handle unexpected crashes
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdown();
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    shutdown();
});
