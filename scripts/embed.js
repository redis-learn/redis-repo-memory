/**
 * embed.js
 *
 * Single place that turns text into an embedding vector.
 *
 * Production uses the OpenAI Embeddings API (text-embedding-3-small).
 * Setting REPO_MEMORY_EMBED_PROVIDER=mock swaps in a deterministic local
 * bag-of-words hash so the scripts can be exercised without an API key or
 * network access. The mock is for tests only; it is never selected unless
 * that environment variable is set.
 */
'use strict';

const MODEL = 'text-embedding-3-small';
const DIM = 1536;

function mockEmbedding(text) {
  const v = new Float32Array(DIM);
  for (const word of text.toLowerCase().match(/[a-z0-9_.]+/g) || []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) {
      h = Math.imul(h ^ word.charCodeAt(i), 16777619) >>> 0;
    }
    v[h % DIM] += 1;
  }
  let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Array.from(v, x => x / norm);
}

function isMock() {
  return process.env.REPO_MEMORY_EMBED_PROVIDER === 'mock';
}

async function embed(text, apiKey) {
  if (isMock()) return mockEmbedding(text);
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey });
  const res = await openai.embeddings.create({ model: MODEL, input: text });
  return res.data[0].embedding;
}

module.exports = { embed, isMock, DIM };
