import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

test('Terminal permission in Digital Human Web edition: non-superadmin forbidden', async (t) => {
    const app = await createServer();
    await app.ready();

    try {
        // 1. 普通用户请求 /api/terminal
        const resUser = await app.inject({
            method: 'GET',
            url: '/api/terminal',
            headers: {
                'x-dh-user': 'normal_user_123',
                'x-dh-displayname': 'Normal User',
            },
        });
        assert.equal(resUser.statusCode, 403);
        const dataUser = JSON.parse(resUser.payload);
        assert.equal(dataUser.code, 'TERMINAL_SUPERADMIN_ONLY');

        // 2. 普通用户请求 /api/terminal/sessions
        const resUserSub = await app.inject({
            method: 'POST',
            url: '/api/terminal/sessions',
            headers: {
                'x-dh-user': 'normal_user_123',
            },
        });
        assert.equal(resUserSub.statusCode, 403);
    } finally {
        await app.close();
    }
});
