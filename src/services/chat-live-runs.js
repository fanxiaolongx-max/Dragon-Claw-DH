// 首页多对话并行：background:true 的流式对话在服务器进程内继续跑，用户切去别的对话或刷新页面不中断，
// 切回来时通过 GET /api/ai/sessions/:sessionId/live 回放已输出内容并无缝续接。
// 说明：
// - 按团队 + 用户隔离，只允许发起人自己观看或停止；
// - 进程内 Map 登记（不新建数据库表、不启子进程），落库仍走现有 ai-service / dao/scoped.js；
// - 完成后事件缓冲保留 60 秒便于刚切回的页面补齐最后几帧，随后自动清理；单次运行事件缓冲上限 2MB。
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { currentTeam } from '../dao/scoped.js';

export const MAX_PARALLEL = 3;
const DONE_TTL_MS = 60_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DELTA_CHUNK = 8192;

const runs = new Map();       // runId -> run
const bySession = new Map();  // `${team}::${sessionId}` -> run

const teamKey = () => String(currentTeam() || 'default');
const sessionKey = (team, sessionId) => `${team}::${sessionId}`;

function activeCount(team, owner) {
    let count = 0;
    for (const run of runs.values()) {
        if (!run.done && run.team === team && run.owner === owner) count += 1;
    }
    return count;
}

function scheduleCleanup(run) {
    const timer = setTimeout(() => {
        runs.delete(run.id);
        if (run.sessionId) {
            const k = sessionKey(run.team, run.sessionId);
            if (bySession.get(k) === run) bySession.delete(k);
        }
    }, DONE_TTL_MS);
    timer.unref?.();
}

export function createRun({ owner, clientRunId = '', question = '' } = {}) {
    const team = teamKey();
    const cleanOwner = String(owner || '');
    if (activeCount(team, cleanOwner) >= MAX_PARALLEL) {
        const err = new Error(`同时进行的对话最多 ${MAX_PARALLEL} 个，请等其中一个完成或停止后再发送`);
        err.status = 429;
        err.code = 'AI_TOO_MANY_RUNS';
        err.limit = MAX_PARALLEL;
        throw err;
    }
    const candidate = String(clientRunId || '');
    const id = /^[A-Za-z0-9_-]{8,64}$/.test(candidate) && !runs.has(candidate) ? candidate : randomUUID();
    const run = {
        id,
        team,
        owner: cleanOwner,
        sessionId: '',
        question: String(question || ''),
        events: [],
        bytes: 0,
        done: false,
        stopRequested: false,
        startedAt: Date.now(),
        emitter: new EventEmitter(),
        abortController: new AbortController(),
    };
    run.emitter.setMaxListeners(50);
    runs.set(id, run);
    return run;
}

export function bindSession(run, sessionId) {
    const sid = String(sessionId || '');
    if (!run || !sid) return;
    run.sessionId = sid;
    bySession.set(sessionKey(run.team, sid), run);
}

export function pushEvent(run, event) {
    if (!run || run.done || !event || typeof event !== 'object') return;
    if (event.sessionId && !run.sessionId) bindSession(run, event.sessionId);
    const serialized = JSON.stringify(event);
    const size = Buffer.byteLength(serialized, 'utf8');
    // 合并相邻小 delta 块，既省内存又让切回回放更流畅
    const prev = run.events[run.events.length - 1];
    if (event.type === 'delta' && prev?.type === 'delta' && (String(prev.delta || '').length + String(event.delta || '').length) <= MAX_DELTA_CHUNK) {
        prev.delta = `${prev.delta || ''}${event.delta || ''}`;
        run.bytes += Buffer.byteLength(String(event.delta || ''), 'utf8');
    } else if (run.bytes + size <= MAX_BYTES || event.type === 'done' || event.type === 'error' || event.type === 'start' || event.type === 'title') {
        run.events.push(event.type === 'delta' ? { type: 'delta', delta: String(event.delta || '') } : event);
        run.bytes += size;
    }
    run.emitter.emit('event', event);
}

export function finishRun(run) {
    if (!run || run.done) return;
    run.done = true;
    run.emitter.emit('end');
    scheduleCleanup(run);
}

export function watchRun(run, reply, { prelude = null } = {}) {
    reply.hijack();
    const raw = reply.raw;
    if (!raw.headersSent) {
        raw.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
        });
    }
    const send = (ev) => {
        if (!raw.destroyed && !raw.writableEnded) {
            raw.write(`${JSON.stringify(ev)}\n`);
        }
    };
    const cleanup = () => {
        run.emitter.off('event', onEvent);
        run.emitter.off('end', onEnd);
    };
    const onEvent = (ev) => send(ev);
    const onEnd = () => {
        cleanup();
        if (!raw.destroyed && !raw.writableEnded) raw.end();
    };
    raw.on('close', cleanup);
    if (prelude) send(prelude);
    for (const ev of run.events) send(ev);
    if (run.done) {
        onEnd();
        return;
    }
    run.emitter.on('event', onEvent);
    run.emitter.on('end', onEnd);
}

export function findBySession(sessionId, { owner, includeDone = false } = {}) {
    const run = bySession.get(sessionKey(teamKey(), String(sessionId || '')));
    if (!run || run.owner !== String(owner || '') || (!includeDone && run.done)) return null;
    return run;
}

export function isRunning(sessionId, owner) {
    return Boolean(findBySession(sessionId, { owner, includeDone: false }));
}

export function stopRun({ runId, sessionId, owner } = {}) {
    const team = teamKey();
    const cleanOwner = String(owner || '');
    const run = runId ? runs.get(String(runId)) : findBySession(sessionId, { owner: cleanOwner, includeDone: true });
    if (!run || run.team !== team || run.owner !== cleanOwner) return false;
    if (run.done) return true;
    run.stopRequested = true;
    run.abortController.abort();
    return true;
}

export function runningSessions(owner) {
    const team = teamKey();
    const cleanOwner = String(owner || '');
    const out = [];
    for (const run of runs.values()) {
        if (!run.done && run.sessionId && run.team === team && run.owner === cleanOwner) {
            out.push({ sessionId: run.sessionId, question: run.question, startedAt: run.startedAt });
        }
    }
    return out;
}

export function _clearForTest() {
    for (const run of runs.values()) {
        if (!run.done) run.abortController.abort();
    }
    runs.clear();
    bySession.clear();
}
