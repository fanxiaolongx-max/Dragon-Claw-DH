import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED_INIT_TABLES } from '../src/dao/scoped.js';
import { getDbUpgradeNote } from '../scripts/check-db-upgrade-diff.mjs';

test('schema-check: EXPECTED_INIT_TABLES lists the 38 base tables plus 26 team tables from db/init.sql', () => {
    assert.equal(EXPECTED_INIT_TABLES.length, 64);
    assert.ok(EXPECTED_INIT_TABLES.includes('team_uiv_scripts'));
    assert.ok(EXPECTED_INIT_TABLES.includes('sys_kv_store'));
    assert.ok(EXPECTED_INIT_TABLES.includes('biz_records'));
    assert.ok(EXPECTED_INIT_TABLES.includes('agent_skills'));
    assert.ok(EXPECTED_INIT_TABLES.includes('custom_tools'));
});

test('check-db-upgrade-diff: accurately returns upgrade script note', () => {
    const note = getDbUpgradeNote();
    assert.ok(typeof note === 'string');
    assert.ok(note.length > 5);
});
