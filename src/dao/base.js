import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent, fetch as undiciFetch } from 'undici';
import { config, endpoints } from '../config.js';
import { DatabaseError } from '../core/errors.js';
import { pushLog } from '../core/log-ring.js';

export const requestContext = new AsyncLocalStorage();

const baseDispatcher = new Agent({
    connect: {
        rejectUnauthorized: config.httpVerifySsl,
        timeout: config.httpTimeoutMs,
    },
    keepAliveTimeout: 10_000,
});

function summarizeSql(sql) {
    return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

async function baseRequest(url, { method = 'POST', body, timeoutMs = config.httpTimeoutMs, tag = 'base' } = {}) {
    if (!url) throw new DatabaseError(`未注入基座 API 地址 (${tag})`);
    const ctx = requestContext.getStore() || {};
    const started = Date.now();
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (ctx.requestId) headers['x-request-id'] = ctx.requestId;

    let resp;
    try {
        resp = await undiciFetch(url, {
            method,
            headers: Object.keys(headers).length ? headers : undefined,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            dispatcher: baseDispatcher,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        const ms = Date.now() - started;
        pushLog({
            level: 'ERROR',
            category: 'BASE_REST',
            requestId: ctx.requestId,
            userId: ctx.userId,
            durationMs: ms,
            message: `${tag} network error: ${error.message}`,
            detail: { url, sql: body?.sql ? summarizeSql(body.sql) : undefined },
        });
        throw new DatabaseError(`基座 API 请求失败：${error.message}`);
    }

    const text = await resp.text();
    const ms = Date.now() - started;
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        pushLog({
            level: 'ERROR',
            category: 'BASE_REST',
            requestId: ctx.requestId,
            userId: ctx.userId,
            durationMs: ms,
            message: `${tag} HTTP ${resp.status} non-JSON response`,
            detail: { preview: text.slice(0, 200) },
        });
        throw new DatabaseError(`基座 HTTP ${resp.status}：${text.slice(0, 200)}`);
    }

    pushLog({
        level: payload?.code === 0 || resp.ok ? 'INFO' : 'WARN',
        category: 'BASE_REST',
        requestId: ctx.requestId,
        userId: ctx.userId,
        durationMs: ms,
        message: `${tag} -> code=${payload?.code ?? resp.status} (${ms}ms)`,
        detail: {
            schema: body?.schema,
            datasourceName: body?.datasourceName,
            key: body?.key,
            pattern: body?.pattern,
            sql: body?.sql ? summarizeSql(body.sql) : undefined,
            rowCount: payload?.data?.rowCount,
            affectedRows: payload?.data?.affectedRows,
            msg: payload?.message,
        },
    });

    if (!resp.ok && payload?.code === undefined) {
        throw new DatabaseError(payload?.message || `基座 HTTP ${resp.status}`);
    }
    return payload;
}

export async function rawBasePost(url, body, tag = 'raw_post', timeoutMs = config.httpTimeoutMs) {
    return baseRequest(url, { method: 'POST', body, timeoutMs, tag });
}

export async function rawBaseGet(url, tag = 'raw_get', timeoutMs = config.httpTimeoutMs) {
    return baseRequest(url, { method: 'GET', timeoutMs, tag });
}

export async function rawBaseDelete(url, body, tag = 'raw_delete', timeoutMs = config.httpTimeoutMs) {
    return baseRequest(url, { method: 'DELETE', body, timeoutMs, tag });
}

export async function queryAppSchema(sql, limit = 500, schemaOverride = '') {
    const schema = schemaOverride || config.appSchema;
    const r = await baseRequest(endpoints.query, {
        tag: `query:${schema || 'app'}`,
        body: {
            datasourceId: config.appDatasourceId,
            schema,
            sql,
            limit,
        },
    });
    if (r.code !== 0) throw new DatabaseError(r.message || '基座查询失败');
    return r.data?.rows ?? [];
}

export async function executeAppSchema(sql, schemaOverride = '') {
    const schema = schemaOverride || config.appSchema;
    const r = await baseRequest(endpoints.execute, {
        tag: `execute:${schema || 'app'}`,
        body: {
            datasourceId: config.appDatasourceId,
            schema,
            sql,
        },
    });
    if (r.code !== 0) throw new DatabaseError(r.message || '基座写操作失败');
    return r.data?.affectedRows ?? 0;
}

export async function queryBusiness(sql, limit = 100) {
    const dsName = String(config.businessDatasourceName || '').trim();
    if (!dsName) {
        throw new DatabaseError('未注入 BUSINESS_DATASOURCE_NAME');
    }
    const r = await baseRequest(endpoints.query, {
        tag: `queryBusiness:${dsName}`,
        body: { datasourceName: dsName, sql, limit },
    });
    if (r.code !== 0) throw new DatabaseError(r.message || '业务库查询失败');
    return r.data?.rows ?? [];
}

export async function checkBaseApi() {
    if (config.localDevMemory) return true;
    if (!endpoints.datasources) return false;
    try {
        const r = await baseRequest(endpoints.datasources, {
            method: 'GET',
            timeoutMs: 3000,
            tag: 'health:datasources',
        });
        return r.code === 0;
    } catch {
        return false;
    }
}
