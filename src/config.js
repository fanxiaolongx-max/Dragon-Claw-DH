import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readVersion() {
    if (process.env.APP_VERSION) return String(process.env.APP_VERSION).trim();
    try {
        return fs.readFileSync(path.join(ROOT, 'dragon-claw-dh.version'), 'utf8').trim() || '1.0.0';
    } catch {
        return '1.0.0';
    }
}

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : !['false', '0', 'no'].includes(String(v).toLowerCase()));

export const ROOT_DIR = ROOT;
export const STATIC_DIR = path.join(ROOT, 'static');
export const TEMPLATES_DIR = path.join(ROOT, 'src', 'templates');

export const config = {
    appName: process.env.APP_NAME || 'Dragon Claw Digital Human',
    appVersion: readVersion(),
    debug: bool(process.env.DEBUG, true),
    nodeEnv: process.env.NODE_ENV || 'production',

    port: num(process.env.PORT, 8000),
    host: process.env.HOST || '0.0.0.0',

    maxPageSize: num(process.env.MAX_PAGE_SIZE, 1000),
    defaultPageSize: num(process.env.DEFAULT_PAGE_SIZE, 50),

    baseUrl: String(process.env.BASE_URL || '').trim(),
    baseQueryUrl: String(process.env.BASE_QUERY_URL || '').trim(),
    baseExecuteUrl: String(process.env.BASE_EXECUTE_URL || '').trim(),
    baseDatasourcesUrl: String(process.env.BASE_DATASOURCES_URL || '').trim(),
    baseFindTableUrl: String(process.env.BASE_FIND_TABLE_URL || '').trim(),
    baseRepOfficesUrl: String(process.env.BASE_REP_OFFICES_URL || '').trim(),
    baseAppMenusUrl: String(process.env.BASE_APP_MENUS_URL || '').trim(),
    baseCacheQueryUrl: String(process.env.BASE_CACHE_QUERY_URL || '').trim(),
    baseCacheExecuteUrl: String(process.env.BASE_CACHE_EXECUTE_URL || '').trim(),
    baseNotifyUrl: String(process.env.BASE_NOTIFY_URL || '').trim(),

    appDatasourceId: num(process.env.APP_DATASOURCE_ID, 0),
    appDatasourceName: String(process.env.APP_DATASOURCE_NAME || '').trim(),
    appSchema: String(process.env.APP_SCHEMA || '').trim(),
    appUuid: String(process.env.APP_UUID || '').trim(),
    appLevel: String(process.env.APP_LEVEL || 'BUSINESS').trim(),
    appRegion: String(process.env.APP_REGION || '').trim(),
    appCacheDatasourceId: num(process.env.APP_CACHE_DATASOURCE_ID, 0),
    appCacheDatasourceName: String(process.env.APP_CACHE_DATASOURCE_NAME || '').trim(),
    businessDatasourceId: num(process.env.BUSINESS_DATASOURCE_ID, 0),
    businessDatasourceName: String(process.env.BUSINESS_DATASOURCE_NAME || '').trim(),
    systemDatasourceId: num(process.env.SYSTEM_DATASOURCE_ID, 0),
    systemDatasourceName: String(process.env.SYSTEM_DATASOURCE_NAME || '').trim(),

    httpTimeoutMs: num(process.env.HTTP_TIMEOUT_MS, num(process.env.HTTP_TIMEOUT, 15) * 1000),
    httpVerifySsl: bool(process.env.HTTP_VERIFY_SSL, false),
    localDevMemory: bool(process.env.LOCAL_DEV_MEMORY, !String(process.env.BASE_QUERY_URL || '').trim()),
};

function deriveFromQuery(suffix) {
    if (!config.baseQueryUrl) return '';
    return config.baseQueryUrl.replace(/\/query\/?$/, suffix);
}

export const endpoints = {
    query: config.baseQueryUrl,
    execute: config.baseExecuteUrl || deriveFromQuery('/execute'),
    datasources: config.baseDatasourcesUrl || (config.baseQueryUrl ? `${config.baseQueryUrl}/datasources` : ''),
    findTable: config.baseFindTableUrl || deriveFromQuery('/query/find-table-datasource'),
    repOffices: config.baseRepOfficesUrl || deriveFromQuery('/common/rep-offices'),
    appMenus: config.baseAppMenusUrl || deriveFromQuery('/app/menus'),
    cacheQuery: config.baseCacheQueryUrl || deriveFromQuery('/cache/query'),
    cacheExecute: config.baseCacheExecuteUrl || deriveFromQuery('/cache/execute'),
    notify: config.baseNotifyUrl || deriveFromQuery('/notify/send'),
};
