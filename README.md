# Simple DVR

Simple DVR на Node.js + FFmpeg для:

- live HLS стриминга RTSP-камер;
- просмотра архива по времени;
- выгрузки архива в MP4;
- автоочистки старых записей по `retentionDays`.

## Что делает сервис

- Запускает `ffmpeg` процесс для каждой камеры из `config.json`.
- Пишет сегменты в `/var/dvr/<camera>/YYYY-MM-DD/HH/*.m4s`.
- Отдает live и archive плейлисты через HTTP.
- Генерирует минутные preview-ролики.
- Чистит старые данные в отдельном worker-потоке (`cleanup-worker.js`).

## Быстрый старт

1. Скопируйте пример конфига:

```bash
cp config.example.json config.json
```

2. Заполните RTSP URL и параметры камер в `config.json`.

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

- `GET /:camera/live.m3u8` (и алиасы `index.m3u8`, `video.m3u8`, `*.fmp4.m3u8`)
- `GET /:camera/dvr.m3u8?start=<ISO>&end=<ISO>`
- `GET /:camera/index-:timestamp-:duration.fmp4.m3u8`
- `GET /:camera/archive-:from-:duration.mp4`
- `GET /:camera/recording_status.json`
- `GET /:camera/:yyyy/:mm/:dd/:HH/:MM/:SS-preview.mp4`
- `GET /dvr/...` прямой доступ к файлам DVR через nginx alias

Подробное описание API и развертывания: [INSTALL.md](./INSTALL.md).

## Конфиг

См. [config.example.json](./config.example.json).

Ключевые параметры:

- `segmentDuration`: длительность HLS сегмента (сек)
- `liveWindow`: размер live-окна в сегментах
- `cleanupIntervalMinutes`: интервал запуска очистки
- `cameras[]`: список камер (`name`, `rtsp`, `retentionDays`, `disableAudio`)

## Systemd

Если запускаете как сервис, внимательно проверьте:

- `WorkingDirectory` должен указывать на реальную папку проекта.
- `ExecStart` должен указывать на реальный путь к `server.js`.

## Лицензия

Проект лицензирован по [LICENSE](./LICENSE).
