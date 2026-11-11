import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

const MAX_ENTRIES = 500;
const entries = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

let seqCounter = 0;

function sanitizeDetail(detail) {
    if (detail == null) return null;
    if (typeof detail === 'string') return detail.slice(0, 1200);
    try {
        const clone = JSON.parse(JSON.stringify(detail, (k, v) => {
            if (/cookie|password|passwd|secret|token|apikey|authorization/i.test(k)) {
                return v ? '[REDACTED]' : '';
            }
            if (typeof v === 'string' && v.length > 800) {
                return `${v.slice(0, 400)}...(${v.length} chars)`;
            }
            return v;
        }));
        return clone;
    } catch {
        return String(detail).slice(0, 800);
    }
}

export function pushLog({ level = 'INFO', category = 'APP', message = '', requestId = '', userId = '', durationMs = null, detail = null } = {}) {
    const entry = {
        id: ++seqCounter,
        ts: new Date().toISOString(),
        level: String(level).toUpperCase(),
        category: String(category).toUpperCase(),
        message: String(message || ''),
        requestId: String(requestId || ''),
        userId: String(userId || ''),
        durationMs: Number.isFinite(durationMs) ? durationMs : null,
        detail: sanitizeDetail(detail),
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    // 同一条日志也按规范输出到 stdout（结构化 JSON，由底座采集）；调试面板读的是上面的环形缓冲
    const fn = entry.level === 'ERROR' ? 'error' : entry.level === 'WARN' ? 'warn' : entry.level === 'DEBUG' ? 'debug' : 'info';
    logger[fn]({ category: entry.category, requestId: entry.requestId || undefined, userId: entry.userId || undefined, durationMs: entry.durationMs ?? undefined, detail: entry.detail ?? undefined }, entry.message);
    emitter.emit('log', entry);
    return entry;
}

export function listLogs({ limit = 200, level = '', category = '', q = '', sinceId = 0 } = {}) {
    const minId = Number(sinceId) || 0;
    const lv = String(level || '').trim().toUpperCase();
    const cat = String(category || '').trim().toUpperCase();
    const kw = String(q || '').trim().toLowerCase();
    let list = entries;
    if (minId > 0) list = list.filter((e) => e.id > minId);
    if (lv && lv !== 'ALL') list = list.filter((e) => e.level === lv);
    if (cat && cat !== 'ALL') list = list.filter((e) => e.category === cat);
    if (kw) {
        list = list.filter((e) => `${e.message} ${e.requestId} ${e.userId} ${JSON.stringify(e.detail || '')}`.toLowerCase().includes(kw));
    }
    const max = Math.min(Math.max(Number(limit) || 200, 1), MAX_ENTRIES);
    return list.slice(-max);
}

export function clearLogs() {
    entries.length = 0;
}

export function subscribeLogs(listener) {
    emitter.on('log', listener);
    return () => emitter.off('log', listener);
}
