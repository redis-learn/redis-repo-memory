/**
 * test_query_mode.js
 *
 * Offline test of the default (store) path and the opt-in query mode, using the mock embedding
 * provider so no OpenAI key or network is needed.
 *
 *   REPO_MEMORY_TEST_REDIS_URL=redis://localhost:6395 node test_query_mode.js
 *
 * Needs a Redis with the Search module (Redis 8+ has it built in). The test refuses to run unless
 * that database is EMPTY, and it deletes everything it creates, so it cannot touch real memory data.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createClient } = require('redis');

const url = process.env.REPO_MEMORY_TEST_REDIS_URL;
if (!url) {
  console.error('Set REPO_MEMORY_TEST_REDIS_URL to an EMPTY Redis (with Search) to run this test.');
  process.exit(2);
}

const dir = __dirname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rrm-test-'));

function run(script, env) {
  return execFileSync('node', [path.join(process.env.SCRIPTS_DIR || dir, script)], {
    env: {
      PATH: process.env.PATH,
      REDIS_URL: url,
      REPO_MEMORY_EMBED_PROVIDER: 'mock',
      GITHUB_REPOSITORY: 'test/repo',
      GITHUB_REF: 'refs/heads/test',
      ...env,
    },
    cwd: dir,
    encoding: 'utf8',
  });
}

function event(name, payload, extra) {
  const p = path.join(tmp, `${name}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(payload));
  return { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: p, ...extra };
}

function results() {
  return JSON.parse(fs.readFileSync('/tmp/memory_results.json', 'utf8'));
}

function pushSeed(message, sha) {
  const env = event('push', { head_commit: { message, author: { name: 't' } } }, { GITHUB_SHA: sha });
  run('collect_context.js', env);
  run('retrieve_memory.js', env);
}

const SEEDS = [
  ['Move the job-queue Jedis use case from JedisPool to RedisClient and close every pipeline', 'a1'.repeat(20)],
  ['Bump Lettuce pins in the harness poms to 7.9.0 and update install snippets', 'b2'.repeat(20)],
  ['Raise the redis-rs response timeout for blocking commands in the Rust demos', 'c3'.repeat(20)],
  ['Rewrite the sorted set tutorial to use ZRANGE with BYSCORE and REV', 'd4'.repeat(20)],
];

async function main() {
  const client = createClient({ url });
  await client.connect();
  try {
    assert.strictEqual(await client.dbSize(), 0, 'refusing to run: the test Redis is not empty');

    // 1. Default path still stores one item per push and reports related ones.
    for (const [msg, sha] of SEEDS) pushSeed(msg, sha);
    assert.strictEqual((await client.keys('memory:*')).length, SEEDS.length, 'default path stores one key per push');
    const first = results();
    assert.strictEqual(first.context.queryMode, undefined, 'push context is not query mode');
    assert.ok(Array.isArray(first.related));

    // 2. QUERY_TEXT is ignored on non-dispatch events.
    const pushEnv = event('push', { head_commit: { message: 'Unrelated change', author: { name: 't' } } },
      { GITHUB_SHA: 'e5'.repeat(20), QUERY_TEXT: 'should be ignored' });
    run('collect_context.js', pushEnv);
    const ignored = JSON.parse(fs.readFileSync('/tmp/memory_context.json', 'utf8'));
    assert.strictEqual(ignored.type, 'push');
    assert.strictEqual(ignored.queryMode, undefined);

    // 3. Query mode is read-only and finds the closest item first.
    const before = (await client.keys('memory:*')).sort();
    const qEnv = event('workflow_dispatch', { sender: { login: 'tester' } }, {
      GITHUB_SHA: 'f6'.repeat(20),
      QUERY_TEXT: 'Move the job-queue Jedis use case to RedisClient and close pipelines',
      QUERY_FILES: 'content/develop/use-cases/job-queue/java-jedis/RedisJobQueue.java',
    });
    run('collect_context.js', qEnv);
    run('retrieve_memory.js', qEnv);
    const q = results();
    assert.strictEqual(q.context.queryMode, true);
    assert.ok(q.related.length >= 1, 'query returns at least one result');
    assert.ok(/JedisPool to RedisClient/.test(q.related[0].title), `closest result first, got: ${q.related[0].title}`);
    assert.strictEqual(q.related[0].fullText, undefined, 'no fullText without a GitHub token / source URL');
    assert.deepStrictEqual((await client.keys('memory:*')).sort(), before, 'query mode wrote nothing');

    // 4. post_comment prints one parseable result line and posts nothing (no token needed).
    const out = run('post_comment.js', { GITHUB_TOKEN: '', GITHUB_EVENT_NAME: 'workflow_dispatch' });
    const line = out.split('\n').find(l => l.startsWith('REPO_MEMORY_QUERY_RESULT_JSON '));
    assert.ok(line, 'result line printed');
    const parsed = JSON.parse(line.slice('REPO_MEMORY_QUERY_RESULT_JSON '.length));
    assert.strictEqual(parsed.results.length, q.related.length);

    // 5. query-max-distance and query-limit are honoured.
    run('retrieve_memory.js', { ...qEnv, QUERY_MAX_DISTANCE: '0.0001' });
    assert.strictEqual(results().related.length, 0, 'tight distance returns nothing');
    run('retrieve_memory.js', { ...qEnv, QUERY_MAX_DISTANCE: '1.5', QUERY_LIMIT: '2' });
    assert.strictEqual(results().related.length, 2, 'limit caps results');

    // 6. With no index, query mode returns nothing and does not create one.
    for (const k of await client.keys('memory:*')) await client.del(k);
    await client.ft.dropIndex('repo_memory_idx');
    run('retrieve_memory.js', qEnv);
    assert.strictEqual(results().related.length, 0);
    const idx = await client.sendCommand(['FT._LIST']);
    assert.ok(!idx.includes('repo_memory_idx'), 'query mode must not create the index');

    console.log('all query-mode tests passed');
  } finally {
    for (const k of await client.keys('memory:*')) await client.del(k);
    await client.ft.dropIndex('repo_memory_idx').catch(() => {});
    await client.quit();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
