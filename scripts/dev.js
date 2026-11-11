import { existsSync } from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
}
if (!process.env.BASE_QUERY_URL && process.env.LOCAL_DEV_MEMORY === undefined) {
    process.env.LOCAL_DEV_MEMORY = '1';
}

await import('../run.js');
