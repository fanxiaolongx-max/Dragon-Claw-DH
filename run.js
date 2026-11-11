import 'node:process';
import { existsSync } from 'node:fs';
import { createServer } from './src/server.js';
import { config } from './src/config.js';
import { pushLog } from './src/core/log-ring.js';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
    try {
        process.loadEnvFile('.env');
    } catch { /* ignore */ }
}

const app = await createServer();

async function start() {
    try {
        await app.listen({ port: config.port, host: config.host });
        pushLog({
            level: 'INFO',
            category: 'BOOT',
            message: `Dragon Claw Digital Human listening on http://${config.host}:${config.port}`,
            detail: { memoryMode: config.localDevMemory, appSchema: config.appSchema || null },
        });
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        try {
            await app.close();
        } finally {
            process.exit(0);
        }
    });
}

await start();
