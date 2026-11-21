import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockBaseServer } from './helpers/mock-base.js';

test('SilentGuard & 结果验真: 数据库更新与删除 0 行时返回 isError, 技能保存回读验真', async () => {
    const mock = await startMockBaseServer();
    Object.assign(process.env, {
        LOCAL_DEV_MEMORY: '0',
        LOG_LEVEL: 'silent',
        BASE_QUERY_URL: `${mock.baseUrl}/query`,
        BASE_EXECUTE_URL: `${mock.baseUrl}/execute`,
        APP_SCHEMA: 'agent-test',
        APP_UUID: 'agent-test',
        APP_DATASOURCE_ID: '2',
    });

    try {
        const { toolByName } = await import('../src/agent/tools.js');
        const updateTool = toolByName.get('update_database_rows');
        const deleteTool = toolByName.get('delete_database_rows');
        const saveSkillTool = toolByName.get('save_skill');

        assert.ok(updateTool, 'update_database_rows 工具存在');
        assert.ok(deleteTool, 'delete_database_rows 工具存在');
        assert.ok(saveSkillTool, 'save_skill 工具存在');

        // 1. 针对不存在的条件进行 update
        const updateRes = await updateTool.run(
            { table: 'ai_chat_sessions', values: { title: '不存在' }, where: "id = 'non-existent-id-99999'" },
            { identity: { isAdmin: true } }
        );
        assert.equal(updateRes.ok, false);
        assert.equal(updateRes.isError, true);
        assert.match(updateRes.summary, /未匹配到任何行/);

        // 2. 针对不存在的条件进行 delete
        const deleteRes = await deleteTool.run(
            { table: 'ai_chat_sessions', where: "id = 'non-existent-id-99999'" },
            { identity: { isAdmin: true } }
        );
        assert.equal(deleteRes.ok, false);
        assert.equal(deleteRes.isError, true);
        assert.match(deleteRes.summary, /未匹配到任何行/);

        // 3. 技能保存并回读验真
        const testSkillMd = `---
id: test_verify_skill
name: 测试验真技能
description: 用于回读校验
---
技能正文内容`;

        const ctx = {
            identity: { username: 'test_admin', isAdmin: true },
            emit: () => {},
        };

        const res = await saveSkillTool.run({ skill_md: testSkillMd, overwrite: true }, ctx);
        assert.equal(res.ok, true);
        assert.equal(res.verified, true);
        assert.match(res.content, /回读验真/);
    } finally {
        await mock.close();
    }
});
