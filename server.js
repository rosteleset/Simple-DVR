const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');

const config = JSON.parse(fs.readFileSync('./config.json'));

const DVR_ROOT = '/var/dvr';
const SEGMENT_DURATION = config.segmentDuration;
const LIVE_SEGMENTS = config.liveWindow;
const CLEAN_INTERVAL = config.cleanupIntervalMinutes * 60 * 1000;

const PREVIEW_DURATION = 0.2; // секунды
const PREVIEW_CHECK_INTERVAL = 15000; // проверять каждые 15 сек

const app = express();
const processes = {};   // ffmpeg processes per camera
let cleanupWorker = null;
let cleanupInProgress = false;
let isShuttingDown = false;

// ----------------------------------------
// Ensure DVR directories exist
// ----------------------------------------

function ensureCameraDirs() {
    if (!fs.existsSync(DVR_ROOT)) {
        fs.mkdirSync(DVR_ROOT);
    }

    for (const cam of config.cameras) {
        const dir = path.join(DVR_ROOT, cam.name);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
        }
    }
}

// ----------------------------------------
// Start FFmpeg
// ----------------------------------------
function startFFmpeg(camera) {

    const outputDir = path.join(DVR_ROOT, camera.name);

    const args = [
        '-rtsp_transport', 'tcp',
        '-i', camera.rtsp
    ];

    // 👉 если в конфиге указано отключить звук
    if (camera.disableAudio === true) {
        args.push('-an');
    }

    // видео всегда копируем
    args.push(
        '-c:v', 'copy'
    );

    // если звук НЕ отключён — просто копируем
    if (camera.disableAudio !== true) {
        args.push('-c:a', 'copy');
    }

    args.push(
        '-f', 'hls',
        '-hls_time', SEGMENT_DURATION,
        '-hls_segment_type', 'fmp4',
        '-hls_playlist_type', 'event',
        '-strftime', '1',
        '-strftime_mkdir', '1',
        '-hls_segment_filename', `${outputDir}/%Y-%m-%d/%H/%Y%m%d_%H%M%S.m4s`,
        `${outputDir}/index.m3u8`
    );

    console.log(`Starting ffmpeg for ${camera.name}`);
    console.log('Args:', args.join(' '));

    const ff = spawn('ffmpeg', args, { stdio: 'ignore' });

    ff.on('exit', (code) => {
        console.log(`${camera.name} ffmpeg exited (${code}), restarting...`);
        setTimeout(() => startFFmpeg(camera), 5000);
    });

    processes[camera.name] = ff;
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
    try {
        const raw = fs.readFileSync('./config.json', 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.cameras)) return parsed.cameras;
    } catch (err) {
        console.error('Failed to read latest cleanup config:', err.message);
    }

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
                // сохраняем относительный путь
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
#EXT-X-TARGETDURATION:${SEGMENT_DURATION}
#EXT-X-MAP:URI="/dvr/${camera}/init.mp4"
`;

    if (mode === 'live') {
        header += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`;
    } else {
        header += `#EXT-X-PLAYLIST-TYPE:VOD\n`;
    }

    let body = segments.map(f =>
        `#EXTINF:${SEGMENT_DURATION.toFixed(3)},\n/dvr/${camera}/${f}`
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
	return res.status(404).send('No segments');
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

        if (gap > SEGMENT_DURATION * 1.5) {
            ranges.push({
                from: currentStart,
                duration: previousTs - currentStart + SEGMENT_DURATION
            });

            currentStart = unix;
        }

        previousTs = unix;
    }

    // закрываем последний диапазон
    if (currentStart !== null && previousTs !== null) {
        ranges.push({
            from: currentStart,
            duration: previousTs - currentStart + SEGMENT_DURATION
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

    if (fs.existsSync(previewFull)) return; // уже есть

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

    const live = segments.slice(-LIVE_SEGMENTS);
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
    const segments = getSegments(camera);

    var start = false
    var end = false


    if (req.params.timestamp && req.params.duration) {

	const unix = parseInt(req.params.timestamp);
	const dur = parseInt(req.params.duration);

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
    const from = parseInt(req.params.from);
    const duration = parseInt(req.params.duration);

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

    const yyyy = parseInt(req.params.yyyy);
    const mm   = parseInt(req.params.mm);
    const dd   = parseInt(req.params.dd);
    const HH   = parseInt(req.params.HH);
    const MM   = parseInt(req.params.MM);
    const SS   = parseInt(req.params.SS);

    // 👉 создаём дату как UTC
    const utcDate = new Date(Date.UTC(yyyy, mm - 1, dd, HH, MM, SS));

    // 👉 переводим в локальное время сервера
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

// ----------------------------------------
// Boot
// ----------------------------------------
ensureCameraDirs();

// запускаем ffmpeg для каждой камеры
for (const cam of config.cameras) {
    startFFmpeg(cam);
}

// запускаем воркер для очистки старых файлов DVR и preview
initCleanupWorker();
setInterval(runCleanup, CLEAN_INTERVAL);

// запускаем проверку на создания новых превью каждые 15 секунд
// при этом сами превью генерируются раз в минуту
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

    for (const name in processes) {
        const proc = processes[name];
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

// если что-то упало
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdown();
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    shutdown();
});
