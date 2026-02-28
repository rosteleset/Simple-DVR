# Simple DVR

Легковесный DVR-сервис на Node.js + FFmpeg для:

- live HLS-стриминга RTSP-камер;
- просмотра архива по диапазону времени;
- выгрузки архива в MP4;
- автоматической очистки старых записей по `retentionDays`.

## Что делает сервис

- Запускает по одному `ffmpeg` процессу на каждую камеру из `config.json`.
- Сохраняет сегменты в `/var/dvr/<camera>/YYYY-MM-DD/HH/*.m4s`.
- Отдает live и archive плейлисты по HTTP.
- Генерирует минутные preview-ролики.
- Запускает очистку в отдельном worker-потоке (`cleanup-worker.js`).

## Быстрый старт

1. Скопируйте шаблон конфига:

```bash
cp config.example.json config.json
```

2. Обновите RTSP URL и параметры камер в `config.json`.

3. Установите зависимости:

```bash
npm init -y
npm install express
```

4. Запустите:

```bash
node server.js
```

## Основные эндпоинты

- `GET /:camera/live.m3u8` (алиасы: `index.m3u8`, `video.m3u8`, `*.fmp4.m3u8`)
- `GET /:camera/dvr.m3u8?start=<ISO>&end=<ISO>`
- `GET /:camera/index-:timestamp-:duration.fmp4.m3u8`
- `GET /:camera/archive-:from-:duration.mp4`
- `GET /:camera/recording_status.json`
- `GET /:camera/:yyyy/:mm/:dd/:HH/:MM/:SS-preview.mp4`
- `GET /dvr/...` прямой доступ к DVR-файлам через nginx alias

Полные детали API и развертывания: [INSTALL.md](./INSTALL.md).

## Конфигурация

См. [config.example.json](./config.example.json).

Ключевые параметры:

- `segmentDuration`: длительность HLS-сегмента (секунды)
- `liveWindow`: размер live-окна (в сегментах)
- `cleanupIntervalMinutes`: интервал запуска очистки
- `cameras[]`: список камер (`name`, `rtsp`, `retentionDays`, `disableAudio`)

## Примечания по systemd

Если запускаете как сервис, проверьте:

- `WorkingDirectory` указывает на реальную директорию проекта.
- `ExecStart` указывает на реальный путь к `server.js`.

`status=200/CHDIR` означает неверный `WorkingDirectory`.

## Лицензия

Лицензия: [LICENSE](./LICENSE).
