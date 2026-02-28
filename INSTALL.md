# Simple DVR Installation

## 1. Требования

- Ubuntu/Debian Linux
- Node.js 20+
- `ffmpeg`
- `nginx`
- `systemd`

Установка пакетов:

```bash
sudo apt update
sudo apt install -y nodejs npm ffmpeg nginx
```

## 2. Подготовка проекта

```bash
cd /opt
sudo git clone <YOUR_REPO_URL> simple-dvr
cd simple-dvr
npm init -y
npm install express
```

## 3. Настройка `config.json`

Отредактируйте файл `config.json`:

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

## 4. Папка архива

По коду архив пишется в `/var/dvr`.

```bash
sudo mkdir -p /var/dvr
sudo chown -R www-data:www-data /var/dvr
sudo chmod -R 755 /var/dvr
```

Если сервис будет работать от другого пользователя, замените `www-data` на него.

## 5. Пробный запуск

```bash
cd /opt/simple-dvr
node server.js
```

Проверка:

- API должен слушать `127.0.0.1:3000`
- HLS/файлы через nginx: `http://<SERVER_IP>:8080/`

Остановить: `Ctrl+C`.

## 6. Nginx

Скопируйте include в nginx:

```bash
sudo cp /opt/simple-dvr/nginx_server.include /etc/nginx/sites-available/simple-dvr.conf
sudo ln -sf /etc/nginx/sites-available/simple-dvr.conf /etc/nginx/sites-enabled/simple-dvr.conf
sudo nginx -t
sudo systemctl reload nginx
```

По умолчанию в проекте используются:

- HTTP: `8080`
- HTTPS: `8443` (нужны валидные пути `ssl_certificate` и `ssl_certificate_key`)

## 7. Systemd сервис

Создайте файл `/etc/systemd/system/simple-dvr.service`:

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

Запуск:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now simple-dvr
sudo systemctl status simple-dvr
```

Логи:

```bash
journalctl -u simple-dvr -f
```

## 8. Методы Simple DVR (API)

Все методы ниже работают через nginx на порту `8080` (или `8443` для SSL).

### 8.1 Live HLS playlist

`GET` (алиасы одного и того же live-плейлиста):

- `/:camera/live.m3u8`
- `/:camera/index.m3u8`
- `/:camera/video.m3u8`
- `/:camera/live.fmp4.m3u8`
- `/:camera/index.fmp4.m3u8`
- `/:camera/video.fmp4.m3u8`

Пример:

```text
http://<SERVER_IP>:8080/cam1/live.m3u8
```

### 8.2 DVR HLS playlist (архив)

`GET` в формате query-параметров:

- `/:camera/dvr.m3u8?start=<ISO_DATE>&end=<ISO_DATE>`

Пример:

```text
http://<SERVER_IP>:8080/cam1/dvr.m3u8?start=2026-02-28T10:00:00Z&end=2026-02-28T10:10:00Z
```

`GET` в формате unix timestamp:

- `/:camera/index-:timestamp-:duration.fmp4.m3u8`
- `/:camera/index-:timestamp-:duration.m3u8`

где:

- `timestamp` — начало в Unix-time (секунды)
- `duration` — длительность (секунды)

Пример:

```text
http://<SERVER_IP>:8080/cam1/index-1740736800-600.fmp4.m3u8
```

### 8.3 Архив в MP4

`GET`:

- `/:camera/archive-:from-:duration.mp4`

где:

- `from` — начало в Unix-time (секунды)
- `duration` — длительность (секунды)

Пример:

```text
http://<SERVER_IP>:8080/cam1/archive-1740736800-600.mp4
```

### 8.4 Статус записей (доступные диапазоны)

`GET`:

- `/:camera/recording_status.json`

Пример:

```text
http://<SERVER_IP>:8080/cam1/recording_status.json
```

Ответ: массив диапазонов записи (`from`, `duration`) для камеры.

### 8.5 Превью mp4-thumbnail по времени

`GET`:

- `/:camera/:yyyy/:mm/:dd/:HH/:MM/:SS-preview.mp4`

Пример:

```text
http://<SERVER_IP>:8080/cam1/2026/02/28/10/15/00-preview.mp4
```

### 8.6 Прямой доступ к сегментам и файлам DVR

Через nginx location `/dvr/` отдается содержимое `/var/dvr/`:

```text
http://<SERVER_IP>:8080/dvr/<camera>/<YYYY-MM-DD>/<HH>/<segment>.m4s
```

## 9. Проверка после установки

Проверьте:

1. Папки камер создаются в `/var/dvr/<camera_name>/`.
2. Внутри появляются структуры `YYYY-MM-DD/HH/*.m4s`.
3. Live-плейлист открывается по URL `http://<SERVER_IP>:8080/<camera>/live.m3u8`.
4. Cleanup удаляет устаревшие часовые/дневные папки по `retentionDays`.

## 10. Важно про изменение `config.json`

- Очистка (cleanup worker) подхватывает `cameras/retentionDays` из `config.json` на следующем цикле cleanup.
- Остальная часть приложения (запуск ffmpeg, интервалы) читает конфиг при старте процесса.
  Для применения этих параметров перезапустите сервис:

```bash
sudo systemctl restart simple-dvr
```
