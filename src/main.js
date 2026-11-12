// 应用主体（ESM）。由根目录的 run.js（CommonJS 启动器）动态加载。
import { createServer } from './server.js';
import { config } from './config.js';
import { pushLog } from './core/log-ring.js';

export async function start() {
    const app = await createServer();

    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, async () => {
            if (closing) return;
            closing = true;
            pushLog({ level: 'INFO', category: 'BOOT', message: `收到 ${signal}，正在关闭` });
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
    // 启动环境快照也放进调试面板的日志里，管理员不用翻平台日志就能看到
    if (globalThis.__dhBootReport) {
        pushLog({ level: 'INFO', category: 'BOOT', message: '启动环境快照', detail: globalThis.__dhBootReport });
    }
    return app;
}
