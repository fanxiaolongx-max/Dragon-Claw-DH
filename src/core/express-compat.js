// 让主线版（Express）的路由处理函数原样跑在 Fastify 上：搬页面后端时不必逐行改写 (req, res) 风格的代码。
// 只实现主线版路由实际用到的那部分：req.user / params / query / body / file，res.status / setHeader / json / send / type / end。
import { BusinessError } from './errors.js';

/** 放在路径和处理函数之间，表示这条路由接收 multipart 上传（对应主线版的 multer.single('file')） */
export const UPLOAD = Symbol('upload');

async function readMultipart(request, maxFileBytes) {
    if (typeof request.parts !== 'function') throw new BusinessError('当前安装包未包含文件上传组件（精简包），请改用完整包', 501);
    const body = {};
    let file;
    for await (const part of request.parts()) {
        if (part.type === 'file') {
            const buffer = await part.toBuffer();
            if (buffer.length > maxFileBytes) throw new BusinessError(`文件不能超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB`, 413);
            file ||= { buffer, originalname: part.filename, mimetype: part.mimetype, size: buffer.length };
        } else {
            body[part.fieldname] = part.value;
        }
    }
    return { body, file };
}

export function expressCompat(fastify, { maxFileBytes = 100 * 1024 * 1024 } = {}) {
    const register = (method) => (url, ...handlers) => {
        const wantsUpload = handlers.includes(UPLOAD);
        const handler = handlers.filter((h) => typeof h === 'function').at(-1);
        fastify.route({
            method,
            url,
            async handler(request, reply) {
                const identity = request.userIdentity;
                const req = {
                    method: request.method, params: request.params, query: request.query || {}, body: request.body, headers: request.headers,
                    user: { username: identity.username, role: identity.isAdmin ? 'admin' : 'user', isSuper: Boolean(identity.isAdmin), tenantId: 'default' },
                };
                if (wantsUpload && /^multipart\/form-data/i.test(String(request.headers['content-type'] || ''))) {
                    Object.assign(req, await readMultipart(request, maxFileBytes));
                }
                const res = {
                    status(code) { reply.code(code); return res; },
                    setHeader(name, value) { reply.header(name, value); return res; },
                    type(value) { reply.type(value); return res; },
                    json(value) { reply.send(value ?? null); return res; },
                    send(value) { reply.send(value); return res; },
                    end() { reply.send(); return res; },
                };
                await handler(req, res);
                return reply;
            },
        });
    };
    return { get: register('GET'), post: register('POST'), put: register('PUT'), patch: register('PATCH'), delete: register('DELETE') };
}
