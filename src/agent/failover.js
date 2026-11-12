// 模型故障切换与熔断：主模型限流、超时、鉴权失败或服务异常时，切到其他已配置密钥的方案。
// 某个方案连续失败 3 次就熔断 60 秒，期间优先跳过它（所有方案都熔断时仍会尝试）。
const breakers = new Map();
const FAIL_LIMIT = 3;
const OPEN_MS = 60_000;

const isOpen = (id) => (breakers.get(id)?.openUntil || 0) > Date.now();
function recordFailure(id) {
    const b = breakers.get(id) || { fails: 0, openUntil: 0 };
    b.fails += 1;
    if (b.fails >= FAIL_LIMIT) { b.openUntil = Date.now() + OPEN_MS; b.fails = 0; }
    breakers.set(id, b);
}
const recordSuccess = (id) => breakers.delete(id);

/** 值得换一个模型再试的错误：限流、鉴权、找不到接口、超时、服务端错误、连不上 */
export function isSwitchable(error) {
    const status = Number(error?.httpStatus || 0);
    if ([401, 403, 404, 408, 409, 425, 429].includes(status) || status >= 500) return true;
    return /连接模型服务失败|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|UND_ERR/i.test(String(error?.message || ''));
}

export function orderCandidates(primary, profiles, autoSwitch) {
    const others = autoSwitch ? profiles.filter((p) => p.id !== primary.id && p.apiKey) : [];
    const all = [primary, ...others];
    const healthy = all.filter((p) => !isOpen(p.id));
    return healthy.length ? healthy : all;
}

/**
 * 依次尝试候选模型。run(settings) 抛错且尚未输出任何内容、错误可切换时，换下一个。
 * delivered() 返回本轮是否已经向用户输出过内容（输出过就不能换，否则会重复）。
 */
export async function withFailover({ candidates, run, delivered, onSwitch }) {
    let lastError;
    for (let i = 0; i < candidates.length; i += 1) {
        const settings = candidates[i];
        try {
            const res = await run(settings);
            recordSuccess(settings.id);
            return { res, settings };
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            lastError = error;
            if (!isSwitchable(error)) throw error;
            recordFailure(settings.id);
            if (delivered() || i === candidates.length - 1) throw error;
            onSwitch?.(settings, candidates[i + 1], error);
        }
    }
    throw lastError;
}
