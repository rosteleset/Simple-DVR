# Simple DVR Installation

## 1. Requirements

- Ubuntu/Debian Linux
- Node.js 20+
- `ffmpeg`
- `nginx`
- `systemd`

Install required packages:

```bash
sudo apt update
sudo apt install -y nodejs npm ffmpeg nginx
```

## 2. Project setup

```bash
cd /opt
sudo git clone <YOUR_REPO_URL> simple-dvr
cd simple-dvr
npm init -y
npm install express
```

## 3. Configure `config.json`

Copy the example and edit your local `config.json`:

```bash
cp config.example.json config.json
```

Example config:

```json
{
  "segmentDuration": 4,
  "liveWindow": 6,
  "cleanupIntervalMinutes": 5,
  "cameras": [
    {
      "name": "cam1",
      "rtsp": "rtsp://login:password@camera-host/stream",
      "retentionDays": 1
    }
  ]
}
```

## 4. DVR storage directory

By default, the service stores recordings in `/var/dvr`.

```bash
sudo mkdir -p /var/dvr
sudo chown -R www-data:www-data /var/dvr
sudo chmod -R 755 /var/dvr
```

If you run the service as another user, replace `www-data` accordingly.

## 5. Test run

```bash
cd /opt/simple-dvr
node server.js
```

Check:

- API listens on `127.0.0.1:3000`
- HLS/files are available via nginx at `http://<SERVER_IP>:8080/`

Stop with `Ctrl+C`.

## 6. Nginx

Copy the provided nginx config include:

```bash
sudo cp /opt/simple-dvr/nginx_server.include /etc/nginx/sites-available/simple-dvr.conf
sudo ln -sf /etc/nginx/sites-available/simple-dvr.conf /etc/nginx/sites-enabled/simple-dvr.conf
sudo nginx -t
sudo systemctl reload nginx
```

Default ports in this project:

- HTTP: `8080`
- HTTPS: `8443` (requires valid `ssl_certificate` and `ssl_certificate_key` paths)

## 7. Systemd service

Create `/etc/systemd/system/simple-dvr.service`:

```ini
[Unit]
Description=Simple DVR Service
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/simple-dvr
ExecStart=/usr/bin/node /opt/simple-dvr/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Start and enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now simple-dvr
sudo systemctl status simple-dvr
```

Logs:

```bash
journalctl -u simple-dvr -f
```

## 8. Simple DVR API methods

All endpoints below are served through nginx on port `8080` (or `8443` for SSL).

### 8.1 Live HLS playlist

`GET` (aliases for the same live playlist):

- `/:camera/live.m3u8`
- `/:camera/index.m3u8`
- `/:camera/video.m3u8`
- `/:camera/live.fmp4.m3u8`
- `/:camera/index.fmp4.m3u8`
- `/:camera/video.fmp4.m3u8`

Example:

```text
http://<SERVER_IP>:8080/cam1/live.m3u8
```

### 8.2 DVR HLS playlist (archive)

`GET` with query parameters:

- `/:camera/dvr.m3u8?start=<ISO_DATE>&end=<ISO_DATE>`

Example:

```text
http://<SERVER_IP>:8080/cam1/dvr.m3u8?start=2026-02-28T10:00:00Z&end=2026-02-28T10:10:00Z
```

`GET` with unix timestamp format:

- `/:camera/index-:timestamp-:duration.fmp4.m3u8`
- `/:camera/index-:timestamp-:duration.m3u8`

Where:

- `timestamp` is start time in Unix seconds
- `duration` is duration in seconds

Example:

```text
http://<SERVER_IP>:8080/cam1/index-1740736800-600.fmp4.m3u8
```

### 8.3 MP4 archive export

`GET`:

- `/:camera/archive-:from-:duration.mp4`

Where:

- `from` is start time in Unix seconds
- `duration` is duration in seconds

Example:

```text
http://<SERVER_IP>:8080/cam1/archive-1740736800-600.mp4
```

### 8.4 Recording ranges status

`GET`:

- `/:camera/recording_status.json`

Example:

```text
http://<SERVER_IP>:8080/cam1/recording_status.json
```

Response contains available recording ranges (`from`, `duration`) for the camera.

### 8.5 Time-based preview clip

`GET`:

- `/:camera/:yyyy/:mm/:dd/:HH/:MM/:SS-preview.mp4`

Example:

```text
http://<SERVER_IP>:8080/cam1/2026/02/28/10/15/00-preview.mp4
```

### 8.6 Direct DVR file access

Nginx serves `/var/dvr/` under `/dvr/`:

```text
http://<SERVER_IP>:8080/dvr/<camera>/<YYYY-MM-DD>/<HH>/<segment>.m4s
```

## 9. Post-install checks

Verify:

1. Camera folders are created in `/var/dvr/<camera_name>/`.
2. The structure `YYYY-MM-DD/HH/*.m4s` appears.
3. Live playlist is available at `http://<SERVER_IP>:8080/<camera>/live.m3u8`.
4. Cleanup removes old hour/day folders according to `retentionDays`.

## 10. Important note about `config.json` changes

- Cleanup worker reads updated `cameras/retentionDays` from `config.json` on the next cleanup cycle.
- The rest of the app (`ffmpeg` startup, intervals, base settings) is read at process start.
  Restart the service to apply those changes:

```bash
sudo systemctl restart simple-dvr
```
