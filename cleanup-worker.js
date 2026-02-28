const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const DVR_ROOT = workerData.DVR_ROOT;
let cameras = Array.isArray(workerData.cameras) ? workerData.cameras : [];

function cleanup() {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Проходим по каждой камере и удаляем папки с видео, которые старше retentionDays
    for (const cam of cameras) {
        // Базовая папка для камеры
        const baseDir = path.join(DVR_ROOT, cam.name);
        // Вычисляем retention в миллисекундах
        const retentionMs = Number(cam.retentionDays) * DAY_MS;

        // Если retentionDays не задано или некорректно, пропускаем эту камеру
        if (!Number.isFinite(retentionMs) || retentionMs < 0) continue;
        // Если папки камеры нет, пропускаем
        if (!fs.existsSync(baseDir)) continue;

        // Читаем папки первого уровня (дни)
        const dayEntries = fs.readdirSync(baseDir, { withFileTypes: true });

        // Папки первого уровня - это дни в формате YYYY-MM-DD
        for (const dayEntry of dayEntries) {
            // Проверяем, что это папка и что имя соответствует формату даты   
            if (!dayEntry.isDirectory()) continue;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dayEntry.name)) continue;

            // Путь к папке дня и вычисляем время окончания этого дня в миллисекундах
            const dayPath = path.join(baseDir, dayEntry.name);
            const dayEnd = new Date(`${dayEntry.name}T23:59:59.999`).getTime();
            
            // Если время окончания дня определено и прошло больше, чем retention, удаляем всю папку дня
            if (Number.isFinite(dayEnd) && (now - dayEnd) > retentionMs) {
                fs.rmSync(dayPath, { recursive: true, force: true });
                continue;
            }

            // Если папка дня не удалена, проверяем папки часов внутри нее
            const hourEntries = fs.readdirSync(dayPath, { withFileTypes: true });

            // Папки второго уровня - это часы в формате HH
            for (const hourEntry of hourEntries) {
                // Проверяем, что это папка и что имя соответствует формату часа
                if (!hourEntry.isDirectory()) continue;
                if (!/^\d{2}$/.test(hourEntry.name)) continue;

                // Путь к папке часа и вычисляем время окончания этого часа в миллисекундах
                const hourPath = path.join(dayPath, hourEntry.name);
                const hourEnd = new Date(
                    `${dayEntry.name}T${hourEntry.name}:59:59.999`
                ).getTime();
                // Если время окончания часа определено и прошло больше, чем retention, удаляем папку часа
                if (Number.isFinite(hourEnd) && (now - hourEnd) > retentionMs) {
                    fs.rmSync(hourPath, { recursive: true, force: true });
                }
            }
        }
    }
}

parentPort.on('message', (msg) => {
    if (!msg || !msg.type) return;

    // Если получили обновленную конфигурацию камер, сохраняем ее для последующих запусков очистки
    if (msg.type === 'updateConfig') {
        if (Array.isArray(msg.cameras)) {
            cameras = msg.cameras;
        }
        return;
    }
    
    // Если получили команду на запуск очистки, выполняем ее 
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
