/**
 * retrieve_memory.js
 *
 * Reads /tmp/memory_context.json (written by collect_context.js), then:
 *   1. Ensures a Redis Search vector index exists (creates it on first run).
 *   2. Embeds the current context using OpenAI text-embedding-3-small.
 *   3. Searches the index for semantically similar prior items (PRs, pushes).
 *   4. Stores the current item in the index for future searches.
 *   5. Writes results to /tmp/memory_results.json for post_comment.js.
 *
 * Required environment variables:
 *   REDIS_URL        Connection string, e.g. redis://default:<pw>@<host>:<port>
 *   OPENAI_API_KEY   OpenAI API key (only the Embeddings API is called)
 *
 * Optional environment variables:
 *   UPSTREAM_REPO    e.g. "redis/docs" — when set, search results also include
 *                    memories from this repo (useful for forks)
 */
'use strict';

const fs = require('fs');
const { createClient, SchemaFieldTypes, VectorAlgorithms } = require('redis');
const { embed, isMock } = require('./embed');

const INDEX_NAME = 'repo_memory_idx';
const KEY_PREFIX = 'memory:';
const VECTOR_DIM = 1536;
const SIMILARITY_THRESHOLD = 0.60; // cosine distance [0,2]; lower = more similar
const TOP_K = 10;
const MAX_RESULTS = 5;

async function ensureIndex(client) {
  const exists = await client.ft.info(INDEX_NAME).then(() => true).catch(() => false);
  if (exists) return;
  await client.ft.create(
    INDEX_NAME,
    {
      type: { type: SchemaFieldTypes.TAG },
      repo: { type: SchemaFieldTypes.TAG },
      title: { type: SchemaFieldTypes.TEXT, WEIGHT: 2 },
      body_summary: { type: SchemaFieldTypes.TEXT },
      source_url: { type: SchemaFieldTypes.TEXT, NOSTEM: true },
      created_at: { type: SchemaFieldTypes.TEXT },
      tags: { type: SchemaFieldTypes.TAG, SEPARATOR: ',' },
      embedding: {
        type: SchemaFieldTypes.VECTOR,
        ALGORITHM: VectorAlgorithms.HNSW,
        TYPE: 'FLOAT32',
        DIM: VECTOR_DIM,
        DISTANCE_METRIC: 'COSINE',
      },
    },
    { ON: 'HASH', PREFIX: KEY_PREFIX }
  );
  console.log(`created index: ${INDEX_NAME}`);
}

const FULL_TEXT_MAX = 8000;

async function githubGet(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  return res.ok ? res.json() : null;
}

// Query mode only. Stored summaries are cut to 500 characters, so look the full text up at the
// source: the squash/merge commit message for a merged PR, the commit message for a push, the
// body otherwise. Returns {} when the lookup fails; the summary is still reported.
async function fullTextFor(item, token) {
  const m = (item.sourceUrl || '').match(/github\.com\/([^/]+\/[^/]+)\/(pull|commit|issues)\/([^/?#]+)/);
  if (!m || !token) return {};
  const [, repo, kind, id] = m;
  try {
    if (kind === 'commit') {
      const c = await githubGet(`/repos/${repo}/commits/${id}`, token);
      return c ? { fullText: c.commit.message.slice(0, FULL_TEXT_MAX), state: 'commit' } : {};
    }
    if (kind === 'pull') {
      const p = await githubGet(`/repos/${repo}/pulls/${id}`, token);
      if (!p) return {};
      if (p.merged && p.merge_commit_sha) {
        const c = await githubGet(`/repos/${repo}/commits/${p.merge_commit_sha}`, token);
        const msg = c && !/^Merge pull request/.test(c.commit.message) ? c.commit.message : (p.body || '');
        return { fullText: msg.slice(0, FULL_TEXT_MAX), state: 'merged', mergedAt: p.merged_at };
      }
      return { fullText: (p.body || '').slice(0, FULL_TEXT_MAX), state: p.state, mergedAt: null };
    }
    const i = await githubGet(`/repos/${repo}/issues/${id}`, token);
    return i ? { fullText: (i.body || '').slice(0, FULL_TEXT_MAX), state: i.state } : {};
  } catch {
    return {};
  }
}

async function main() {
  const redisUrl = process.env.REDIS_URL;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!redisUrl) {
    console.error('REDIS_URL secret is not set');
    process.exit(1);
  }
  if (!openaiKey && !isMock()) {
    console.error('OPENAI_API_KEY secret is not set');
    process.exit(1);
  }

  const context = JSON.parse(fs.readFileSync('/tmp/memory_context.json', 'utf8'));
  const queryMode = context.queryMode === true;

  const client = createClient({ url: redisUrl });
  client.on('error', err => console.error('Redis error:', err.message));
  await client.connect();

  try {
    if (queryMode) {
      // Read-only: never create the index or write anything.
      const exists = await client.ft.info(INDEX_NAME).then(() => true).catch(() => false);
      if (!exists) {
        fs.writeFileSync('/tmp/memory_results.json', JSON.stringify({ context, sourceUrl: '', related: [] }, null, 2));
        console.log('query_mode index=missing related_count=0');
        return;
      }
    } else {
      await ensureIndex(client);
    }

    const embedding = await embed(context.searchText || context.title, openaiKey);
    const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

    const queryLimit = Math.max(1, parseInt(process.env.QUERY_LIMIT || '', 10) || MAX_RESULTS);
    const queryMaxDistance = parseFloat(process.env.QUERY_MAX_DISTANCE || '') || SIMILARITY_THRESHOLD;
    const topK = queryMode ? Math.max(TOP_K, queryLimit * 2) : TOP_K;

    const searchResult = await client.ft.search(
      INDEX_NAME,
      `*=>[KNN ${topK} @embedding $BLOB AS score]`,
      {
        PARAMS: { BLOB: embeddingBuffer },
        RETURN: ['type', 'title', 'body_summary', 'source_url', 'created_at', 'score', 'repo'],
        SORTBY: { BY: 'score', DIRECTION: 'ASC' },
        DIALECT: 2,
      }
    );

    // Build current item ID so we can exclude it from results
    const safeRepo = context.repo.replace(/\//g, '_');
    const threshold = queryMode ? queryMaxDistance : SIMILARITY_THRESHOLD;
    const maxResults = queryMode ? queryLimit : MAX_RESULTS;
    const itemId = context.prNumber
      ? `${safeRepo}_pr_${context.prNumber}`
      : `${safeRepo}_push_${context.sha?.slice(0, 8)}`;
    // Exclude the current item AND the push memory for the same SHA — a commit
    // pushed to a branch before a PR opens gets stored as _push_{sha} and would
    // otherwise surface as a related item when the PR runs.
    const excludeKeys = new Set([
      `${KEY_PREFIX}${itemId}`,
      `${KEY_PREFIX}${safeRepo}_push_${context.sha?.slice(0, 8)}`,
    ]);

    // Match memories from the current repo and optionally the upstream repo.
    const allowedRepos = new Set([context.repo, process.env.UPSTREAM_REPO].filter(Boolean));
    const related = searchResult.documents
      .filter(doc => {
        const score = parseFloat(doc.value.score ?? '2');
        return score < threshold && allowedRepos.has(doc.value.repo) && !excludeKeys.has(doc.id);
      })
      .slice(0, maxResults);

    if (queryMode) {
      const token = process.env.GITHUB_TOKEN;
      const items = [];
      for (const doc of related) {
        const item = {
          type: doc.value.type,
          title: doc.value.title,
          bodySummary: doc.value.body_summary,
          sourceUrl: doc.value.source_url,
          createdAt: doc.value.created_at,
          score: parseFloat(doc.value.score ?? '2'),
        };
        items.push({ ...item, ...(await fullTextFor(item, token)) });
      }
      fs.writeFileSync('/tmp/memory_results.json', JSON.stringify({ context, sourceUrl: '', related: items }, null, 2));
      console.log(`query_mode related_count=${items.length}`);
      return;
    }

    // Store the current context as a memory artifact

    const sourceUrl = context.prNumber
      ? `https://github.com/${context.repo}/pull/${context.prNumber}`
      : `https://github.com/${context.repo}/commit/${context.sha}`;

    await client.hSet(`${KEY_PREFIX}${itemId}`, {
      id: itemId,
      type: context.type === 'pull_request' ? 'pr_summary' : 'push_summary',
      repo: context.repo,
      title: context.title,
      body_summary: context.body.slice(0, 500),
      source_url: sourceUrl,
      created_at: context.timestamp,
      tags: context.labels.join(','),
      embedding: embeddingBuffer,
    });

    console.log(`stored=${KEY_PREFIX}${itemId} related_count=${related.length}`);

    fs.writeFileSync(
      '/tmp/memory_results.json',
      JSON.stringify(
        {
          context,
          sourceUrl,
          related: related.map(doc => ({
            type: doc.value.type,
            title: doc.value.title,
            bodySummary: doc.value.body_summary,
            sourceUrl: doc.value.source_url,
            createdAt: doc.value.created_at,
            score: parseFloat(doc.value.score ?? '2'),
          })),
        },
        null,
        2
      )
    );
  } finally {
    await client.quit();
  }
}

main().catch(err => {
  console.error('retrieve_memory failed:', err.message);
  process.exit(1);
});
