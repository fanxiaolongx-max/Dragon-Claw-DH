// 保险箱接口（路径、请求体、返回体与主线版 routes/vault.js 的密钥部分一致）。
// 每人只能读写自己的条目；响应一律不缓存。基座 Web 版没有网站登录凭据，列表恒为空并用 features 告诉前端只显示密钥页。
import { BusinessError } from '../core/errors.js';
import { resolveRequestIdentity } from '../core/identity.js';
import { isAuthEnforced } from '../core/access.js';
import { recordAudit } from '../services/audit-service.js';
import { listSecrets, saveSecret, updateSecret, removeSecret, revealSecret, vaultFeatures } from '../services/vault-service.js';

// 没有登录密码可复核：查看明文按账号限次，并逐条记审计
const REVEAL_LIMIT = 20;
const REVEAL_WINDOW_MS = 10 * 60 * 1000;
const reveals = new Map();

function ownerOf(req) {
    const identity = resolveRequestIdentity(req);
    if (!identity.identified && isAuthEnforced()) throw new BusinessError('请先登录', 401);
    return identity.username;
}

export async function vaultRoutes(fastify) {
    fastify.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });

    fastify.get('/', async (req) => { ownerOf(req); return { entries: [], neverSave: [], features: vaultFeatures() }; });

    fastify.get('/secrets', async (req) => listSecrets(ownerOf(req)));
    fastify.post('/secrets', async (req) => {
        const { name, value, category, label } = req.body || {};
        return saveSecret(ownerOf(req), { name, value, category, label });
    });
    fastify.put('/secrets/:id', async (req) => {
        const { name, value, category, label } = req.body || {};
        return { secret: await updateSecret(ownerOf(req), req.params.id, { name, value: value === '' ? undefined : value, category, label }) };
    });
    fastify.delete('/secrets/:id', async (req) => { await removeSecret(ownerOf(req), req.params.id); return { success: true }; });
    fastify.post('/secrets/:id/reveal', async (req) => {
        const owner = ownerOf(req);
        const now = Date.now();
        const recent = (reveals.get(owner) || []).filter((at) => now - at < REVEAL_WINDOW_MS);
        if (recent.length >= REVEAL_LIMIT) throw new BusinessError('查看次数过多，请 10 分钟后再试', 429);
        reveals.set(owner, [...recent, now]);
        const { name, value } = await revealSecret(owner, req.params.id);
        await recordAudit(req, { actor: owner, action: 'vault_reveal', target: name });
        return { value };
    });
}
