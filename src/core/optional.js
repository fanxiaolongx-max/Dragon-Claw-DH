// 规范 §4.2 白名单之外的依赖一律按需加载：
// 精简包（npm run build:lite）不含这些依赖时，对应功能返回明确提示，其余功能和进程启动不受影响。
import { BusinessError } from './errors.js';

const cache = new Map();

export async function optionalDep(name, feature) {
    if (cache.has(name)) return cache.get(name);
    try {
        const mod = await import(name);
        cache.set(name, mod);
        return mod;
    } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/.test(String(error?.message))) {
            throw new BusinessError(`「${feature}」需要依赖 ${name}，当前安装包未包含该依赖（精简包）。请改用完整包，或在页面内使用浏览器端导出。`, 501);
        }
        throw error;
    }
}

export async function hasOptionalDep(name) {
    try { await optionalDep(name, name); return true; } catch { return false; }
}
