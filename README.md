# Simple DVR

A lightweight DVR service built with Node.js + FFmpeg for:

- live HLS streaming from RTSP cameras;
- archive playback by time range;
- MP4 archive export;
- automatic retention cleanup using `retentionDays`.

Repository: `https://github.com/rosteleset/Simple-DVR.git`

## What the service does

- Starts one `ffmpeg` process per camera from `config.json`.
- Stores segments in `/var/dvr/<camera>/YYYY-MM-DD/HH/*.m4s`.
- Serves live and archive playlists over HTTP.
- Generates minute preview clips.
- Runs cleanup in a dedicated worker thread (`cleanup-worker.js`).

## Quick start

1. Copy the config template:

```bash
cp config.example.json config.json
```

2. Update RTSP URLs and camera settings in `config.json`.

3. Install dependencies:

```bash
npm init -y
npm install express
```

4. Run:

```bash
node server.js
```

## Main endpoints

- `GET /:camera/live.m3u8` (aliases: `index.m3u8`, `video.m3u8`, `*.fmp4.m3u8`)
- `GET /:camera/dvr.m3u8?start=<ISO>&end=<ISO>`
- `GET /:camera/index-:timestamp-:duration.fmp4.m3u8`
- `GET /:camera/archive-:from-:duration.mp4`
- `GET /:camera/recording_status.json`
- `GET /:camera/:yyyy/:mm/:dd/:HH/:MM/:SS-preview.mp4`
- `GET /dvr/...` direct DVR file access via nginx alias

For full API and deployment details, see [INSTALL.md](./INSTALL.md).

## Configuration

See [config.example.json](./config.example.json).

Key parameters:

- `segmentDuration`: HLS segment duration (seconds)
- `liveWindow`: live window size (segments)
- `cleanupIntervalMinutes`: cleanup interval
- `cameras[]`: camera list (`name`, `rtsp`, `retentionDays`, `disableAudio`)

## Systemd notes

If you run this as a service, verify:

- `WorkingDirectory` points to the real project directory.
- `ExecStart` points to the real `server.js` path.

## License

Licensed under [LICENSE](./LICENSE).
