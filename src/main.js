// 应用主体（ESM）。由根目录的 run.js（CommonJS 启动器）动态加载。
import { createServer } from './server.js';
import { config } from './config.js';
import { pushLog } from './core/log-ring.js';
import { startScheduler, stopScheduler } from './services/schedule-service.js';
import { startDataWatch, stopDataWatch } from './services/data-watch-service.js';
import './services/data-dictionary-service.js';
import './services/data-issue-service.js';

export async function start() {
    const app = await createServer();

    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, async () => {
            if (closing) return;
            closing = true;
            pushLog({ level: 'INFO', category: 'BOOT', message: `收到 ${signal}，正在关闭` });
            stopScheduler();
            stopDataWatch();
            try {
                await app.close();
            } finally {
                process.exit(0);
            }
        });
    }

    await app.listen({ port: config.port, host: config.host });
    pushLog({
        level: 'INFO',
        category: 'BOOT',
        message: `server started: Dragon Claw Digital Human listening on http://${config.host}:${config.port}`,
        detail: { memoryMode: config.localDevMemory, appSchema: config.appSchema || null },
    });
    // 未注入基座地址也不是内存模式时，数据接口都不可用，定时任务也就不必轮询
    if (config.localDevMemory || config.baseQueryUrl) startScheduler();
    // 数据巡检：没授权业务数据源时每次检查直接跳过
    if (config.baseQueryUrl) startDataWatch();
    // 内置的表字典与看板 SQL：启动后导入一次（内容没变就跳过），失败不影响服务
    if (config.localDevMemory || config.baseQueryUrl) {
        // 基座可能比应用晚就绪（启动时 fetch failed）：失败就隔一段时间再试，直到成功
        const delays = [15, 60, 300, 900, 1800, 3600].map((sec) => sec * 1000);
        const attempt = async (n = 0) => {
            let failed = '';
            try {
                const out = await (await import('./services/data-dictionary-service.js')).applyBundledDefaults();
                failed = Object.entries(out || {}).filter(([, r]) => r?.error).map(([f, r]) => `${f}：${r.error}`).join('；');
            } catch (error) { failed = error.message; }
            if (!failed) return;
            const wait = delays[Math.min(n, delays.length - 1)];
            pushLog({ level: 'WARN', category: 'DATA_WATCH', message: `导入内置表字典 / 看板 SQL 失败，${Math.round(wait / 1000)} 秒后重试：${failed}` });
            setTimeout(() => attempt(n + 1), wait).unref?.();
        };
        attempt();
    }
    // 启动环境快照也放进调试面板的日志里，管理员不用翻平台日志就能看到
    if (globalThis.__dhBootReport) {
        pushLog({ level: 'INFO', category: 'BOOT', message: '启动环境快照', detail: globalThis.__dhBootReport });
    }
    return app;
}
