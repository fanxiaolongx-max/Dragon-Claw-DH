import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, config } from '../config.js';
import { kvGet, kvSet, selectTable } from '../dao/scoped.js';
import { BusinessError } from '../core/errors.js';
import {
    listCategories as listSlaCategories,
    replaceCategories as replaceSlaCategories,
    listGroups,
    replaceGroups,
    getTargets,
    patchTargetsBulk,
    getPrefsObject,
    patchPrefsBulk,
} from './sla-service.js';
import {
    listCategories as listUivCategories,
    addCategory as addUivCategory,
    listScripts,
    saveScripts,
} from './uiv-service.js';

const STATE_KEY = 'onboarding_defaults_state';
const BUNDLE_PATH = path.join(ROOT_DIR, 'src', 'defaults', 'quick-start-bundle.json');

let cachedBundle = null;
const seededBySchema = new Map();
const inFlightSeeds = new Map();

function loadBundle() {
    if (cachedBundle) return cachedBundle;
    const raw = fs.readFileSync(BUNDLE_PATH, 'utf8');
    cachedBundle = JSON.parse(raw);
    return cachedBundle;
}

function uniqueStrings(existingList = [], incomingList = []) {
    const output = [];
    const seen = new Set();
    let added = 0;
    for (const item of existingList) {
        const text = String(item || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        output.push(text);
    }
    for (const item of incomingList) {
        const text = String(item || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        output.push(text);
        added += 1;
    }
    return { items: output, added };
}

function collectMissingScripts(existingScripts = [], defaultScripts = []) {
    const existingIds = new Set(existingScripts.map((s) => String(s?.id || '').trim()).filter(Boolean));
    const existingKeys = new Set(existingScripts.map((s) => `${String(s?.category || '默认分类').trim()}::${String(s?.name || '').trim()}`));
    const existingUrls = new Set(existingScripts.map((s) => `${String(s?.name || '').trim()}::${String(s?.url || '').trim()}`));
    const missing = [];
    for (const script of defaultScripts) {
        if (!script || typeof script !== 'object') continue;
        const id = String(script.id || '').trim();
        const catNameKey = `${String(script.category || '默认分类').trim()}::${String(script.name || '').trim()}`;
        const urlKey = `${String(script.name || '').trim()}::${String(script.url || '').trim()}`;
        if ((id && existingIds.has(id)) || existingKeys.has(catNameKey) || (script.url && existingUrls.has(urlKey))) {
            continue;
        }
        missing.push(script);
        if (id) existingIds.add(id);
        existingKeys.add(catNameKey);
        existingUrls.add(urlKey);
    }
    return missing;
}

function mergeGroups(existingGroups = [], defaultGroups = []) {
    const output = existingGroups.map((g) => ({ ...g }));
    const identities = new Set(output.flatMap((g) => [
        g.id ? `id:${String(g.id).toLowerCase()}` : '',
        g.key ? `id:${String(g.key).toLowerCase()}` : '',
        g.name ? `name:${String(g.name).trim().toLowerCase()}` : '',
    ]).filter(Boolean));
    let added = 0;
    for (const g of defaultGroups) {
        if (!g || typeof g !== 'object') continue;
        const keys = [
            g.id ? `id:${String(g.id).toLowerCase()}` : '',
            g.key ? `id:${String(g.key).toLowerCase()}` : '',
            g.name ? `name:${String(g.name).trim().toLowerCase()}` : '',
        ].filter(Boolean);
        if (keys.some((k) => identities.has(k))) continue;
        output.push(g);
        keys.forEach((k) => identities.add(k));
        added += 1;
    }
    return { items: output, added };
}

function buildMetadata(bundle) {
    let pkgVersion = '1.0.0';
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
        pkgVersion = pkg.version || pkgVersion;
    } catch {
        // ignore missing package.json
    }
    return {
        version: pkgVersion,
        builtAt: bundle?.generatedAt || null,
        nodeVersion: process.version,
        electronVersion: null,
        platformLabel: 'Web Server',
        isPortable: false,
        dependencies: [],
    };
}

export async function applyBundledDefaults({ importScripts = true, importMetricRules = true } = {}) {
    const bundle = loadBundle();
    const result = {
        scriptsAdded: 0,
        scriptCategoriesAdded: 0,
        targetsAdded: 0,
        preferencesAdded: 0,
        groupsAdded: 0,
        categoriesAdded: 0,
    };

    if (importScripts) {
        const defaultUivCats = Array.isArray(bundle.uiv?.categories) ? bundle.uiv.categories : [];
        const existingUivCats = new Set(await listUivCategories());
        for (const cat of defaultUivCats) {
            const name = String(cat || '').trim();
            if (!name || existingUivCats.has(name)) continue;
            await addUivCategory(name);
            existingUivCats.add(name);
            result.scriptCategoriesAdded += 1;
        }
        const existingScripts = await listScripts();
        const missingScripts = collectMissingScripts(existingScripts, Array.isArray(bundle.uiv?.scripts) ? bundle.uiv.scripts : []);
        if (missingScripts.length) {
            await saveScripts(missingScripts);
            result.scriptsAdded = missingScripts.length;
        }
    }

    if (importMetricRules) {
        const [existingCats, existingGroups, existingTargets, existingPrefs] = await Promise.all([
            listSlaCategories(),
            listGroups(),
            getTargets(),
            getPrefsObject(),
        ]);

        const mergedCats = uniqueStrings(existingCats, Array.isArray(bundle.sla?.categories) ? bundle.sla.categories : []);
        if (mergedCats.added > 0) {
            await replaceSlaCategories(mergedCats.items);
            result.categoriesAdded = mergedCats.added;
        }

        const mergedGroups = mergeGroups(existingGroups, Array.isArray(bundle.sla?.groups) ? bundle.sla.groups : []);
        if (mergedGroups.added > 0) {
            await replaceGroups(mergedGroups.items);
            result.groupsAdded = mergedGroups.added;
        }

        const missingTargets = {};
        for (const [k, v] of Object.entries(bundle.sla?.targets || {})) {
            if (!Object.prototype.hasOwnProperty.call(existingTargets, k)) {
                missingTargets[k] = v;
            }
        }
        const targetKeys = Object.keys(missingTargets);
        if (targetKeys.length) {
            await patchTargetsBulk(missingTargets, Object.keys(existingTargets).length);
            result.targetsAdded = targetKeys.length;
        }

        const missingPrefs = {};
        for (const [k, v] of Object.entries(bundle.sla?.prefs || {})) {
            if (!Object.prototype.hasOwnProperty.call(existingPrefs, k) || existingPrefs[k] == null) {
                missingPrefs[k] = v;
            }
        }
        const prefKeys = Object.keys(missingPrefs);
        if (prefKeys.length) {
            await patchPrefsBulk(missingPrefs);
            result.preferencesAdded = prefKeys.length;
        }
    }

    return result;
}

export async function ensureQuickStartSeeded() {
    const schemaKey = `${config.appSchema || 'default'}:${config.localDevMemory ? 'mem' : 'db'}`;
    if (seededBySchema.get(schemaKey)) return;
    if (inFlightSeeds.has(schemaKey)) return inFlightSeeds.get(schemaKey);

    const job = (async () => {
        try {
            const existingState = await kvGet(STATE_KEY, null);
            if (existingState) {
                seededBySchema.set(schemaKey, true);
                return;
            }
            const [hasTargets, hasPrefs, hasScripts] = await Promise.all([
                selectTable('sla_targets', { columns: ['id'], limit: 1 }),
                selectTable('sla_config_items', { columns: ['id'], whereSql: "`scope_key` = 'sla_pref'", limit: 1, memFilter: (r) => r.scope_key === 'sla_pref' }),
                selectTable('uiv_scripts', { columns: ['id'], limit: 1 }),
            ]);
            if (hasTargets.length || hasPrefs.length || hasScripts.length) {
                seededBySchema.set(schemaKey, true);
                return;
            }
            const bundle = loadBundle();
            const result = await applyBundledDefaults({ importScripts: true, importMetricRules: true });
            await kvSet(STATE_KEY, {
                decision: 'imported',
                autoSeeded: true,
                decidedAt: new Date().toISOString(),
                bundleVersion: bundle.bundleVersion || '1.0.0',
                imported: { scripts: true, metricRules: true },
                result,
            });
            seededBySchema.set(schemaKey, true);
        } finally {
            inFlightSeeds.delete(schemaKey);
        }
    })();

    inFlightSeeds.set(schemaKey, job);
    return job;
}

export async function getOnboardingStatus({ role = 'user' } = {}) {
    await ensureQuickStartSeeded();
    const bundle = loadBundle();
    const state = await kvGet(STATE_KEY, null);
    const isAdmin = role === 'admin';
    return {
        // Web 部署直接提供开箱即用基线，不在首页弹出桌面端首次启动阻塞模态框
        required: false,
        decided: Boolean(state),
        requiresAdmin: !isAdmin,
        state,
        build: buildMetadata(bundle),
        bundle: {
            version: bundle.bundleVersion || '1.0.0',
            generatedAt: bundle.generatedAt || null,
            description: bundle.description || '',
            mergePolicy: bundle.mergePolicy || 'preserve-existing',
            summary: bundle.summary || null,
        },
    };
}

export async function applyOnboardingDecision({
    action,
    importScripts = false,
    importMetricRules = false,
    allowRepeat = false,
    role = 'user',
} = {}) {
    if (role !== 'admin') {
        const err = new BusinessError('仅管理员可执行默认配置初始化', 403);
        err.statusCode = 403;
        err.code = 'ADMIN_REQUIRED';
        throw err;
    }
    const existingState = await kvGet(STATE_KEY, null);
    if (existingState && allowRepeat !== true) {
        throw new BusinessError('默认初始化选择已完成，可在全局设置中补充导入', 409);
    }

    const bundle = loadBundle();
    if (action === 'skip') {
        const nextState = {
            decision: 'skipped',
            decidedAt: new Date().toISOString(),
            bundleVersion: bundle.bundleVersion || '1.0.0',
            imported: { scripts: false, metricRules: false },
            result: null,
        };
        await kvSet(STATE_KEY, nextState);
        return { success: true, state: nextState };
    }

    if (action !== 'import') {
        throw new BusinessError('无效的初始化操作', 400);
    }
    if (!importScripts && !importMetricRules) {
        throw new BusinessError('请至少选择一项需要导入的默认配置', 400);
    }

    const result = await applyBundledDefaults({
        importScripts: Boolean(importScripts),
        importMetricRules: Boolean(importMetricRules),
    });
    const nextState = {
        decision: 'imported',
        decidedAt: new Date().toISOString(),
        bundleVersion: bundle.bundleVersion || '1.0.0',
        imported: {
            scripts: Boolean(importScripts),
            metricRules: Boolean(importMetricRules),
        },
        result,
    };
    await kvSet(STATE_KEY, nextState);
    return { success: true, state: nextState };
}
