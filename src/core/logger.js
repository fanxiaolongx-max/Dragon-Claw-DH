import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
    level: config.logLevel || (config.debug ? 'debug' : 'info'),
    base: {
        app: config.appUuid || 'local',
        region: config.appRegion || '',
        version: config.appVersion,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.secret', '*.apiKey'],
        censor: '[REDACTED]',
    },
});
