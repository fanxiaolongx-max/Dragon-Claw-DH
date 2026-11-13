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
    debug: bool(process.env.DEBUG, false),
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
    // 业务数据源里的库名（NetCare 数据探查按它读表目录）；平台没有单独注入时按约定取 netcare
    businessSchema: String(process.env.BUSINESS_SCHEMA || 'netcare').trim(),
    systemDatasourceId: num(process.env.SYSTEM_DATASOURCE_ID, 0),
    systemDatasourceName: String(process.env.SYSTEM_DATASOURCE_NAME || '').trim(),

    httpTimeoutMs: num(process.env.HTTP_TIMEOUT_MS, num(process.env.HTTP_TIMEOUT, 15) * 1000),
    httpVerifySsl: bool(process.env.HTTP_VERIFY_SSL, false),
    // 内存模式只在显式声明时启用（scripts/dev.js 会设置）。基座未注入地址时不静默降级：数据接口直接报错。
    localDevMemory: bool(process.env.LOCAL_DEV_MEMORY, false),

    // 管理员：工号白名单（逗号分隔）。未配置时由首位已识别用户自动成为管理员，之后在界面里维护。
    adminUsers: String(process.env.DH_ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    openAdmin: bool(process.env.DH_OPEN_ADMIN, false),
    // 落库密钥的加密口令；未配置时退化为按应用 UUID 派生（仅防明文暴露，见 README 安全说明）
    secretKey: String(process.env.DH_SECRET_KEY || '').trim(),

    // 大字段分片阈值（字符数）：超过即切片存入 dh_chunks
    chunkChars: Math.max(8192, num(process.env.DH_CHUNK_CHARS, 131072)),
    logLevel: String(process.env.LOG_LEVEL || '').trim(),

    // 模型默认配置：平台用环境变量注入时无需在界面里再填
    aiApiBaseUrl: String(process.env.AI_API_BASE_URL || '').trim(),
    aiModel: String(process.env.AI_MODEL || '').trim(),
    aiApiKey: String(process.env.AI_API_KEY || '').trim(),
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
