/**
 * post_comment.js
 *
 * Reads /tmp/memory_results.json (written by retrieve_memory.js) and posts
 * the results to GitHub:
 *   - Pull requests: maintains a SINGLE comment with related history. Every
 *     event (including new commits pushed via `synchronize`) updates that
 *     same comment, accumulating newly-discovered memories rather than
 *     posting a new comment each time. The full memory set is persisted in a
 *     hidden, base64-encoded JSON blob inside the comment so each run can
 *     reconstruct the prior list and union it with the current findings.
 *   - Pushes: posts a commit status and writes to the Actions step summary.
 *
 * Required environment variables:
 *   GITHUB_TOKEN       Automatically provided by Actions. Needs pull-requests:write
 *                      and statuses:write permissions (set in the workflow file).
 *   GITHUB_REPOSITORY  Automatically provided by Actions.
 */
'use strict';

const fs = require('fs');

const COMMENT_MARKER = '<!-- redis-repo-memory -->';
const DATA_MARKER = 'redis-repo-memory-data:';

async function githubRequest(method, path, body, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// Stable identity for a memory item, used to dedupe across commits.
function itemKey(item) {
  return item.sourceUrl || `${item.type}:${item.title}`;
}

// Serialize the memory set into a compact, comment-safe blob.
function encodeItems(items) {
  return Buffer.from(JSON.stringify(items), 'utf8').toString('base64');
}

// Recover the memory set previously stored in a comment body.
function extractStoredItems(body) {
  const m = body && body.match(new RegExp(`<!--\\s*${DATA_MARKER}\\s*([A-Za-z0-9+/=]*)\\s*-->`));
  if (!m) return [];
  try {
    const parsed = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Merge the current run's items into the prior set. Prior items keep their
// order; genuinely new items are appended. Returns { merged, newKeys }.
function mergeItems(priorItems, related) {
  const keys = new Set(priorItems.map(itemKey));
  const merged = priorItems.slice();
  const newKeys = new Set();
  for (const item of related) {
    const key = itemKey(item);
    if (!keys.has(key)) {
      merged.push(item);
      keys.add(key);
      newKeys.add(key);
    }
  }
  return { merged, newKeys };
}

// Build the comment/summary markdown. When newKeys is provided, items found
// in the current run are flagged; pass null for contexts without accumulation.
function buildMarkdown(items, context, sourceUrl, newKeys) {
  const lines = [
    COMMENT_MARKER,
    '## 🧠 Redis Memory',
    '',
  ];

  if (items.length === 0) {
    lines.push("No related prior context found — this looks new to the repository's memory.");
  } else {
    const newCount = newKeys ? items.filter(i => newKeys.has(itemKey(i))).length : 0;
    let summary = `Found **${items.length}** related item${items.length === 1 ? '' : 's'} from repository history`;
    if (newCount > 0) {
      summary += ` (**${newCount}** new this commit)`;
    }
    lines.push(summary + ':');
    lines.push('');
    for (const item of items) {
      const label = item.type === 'pr_summary' ? 'PR' : item.type === 'issue_summary' ? 'Issue' : 'Commit';
      const link = item.sourceUrl ? `[${item.title}](${item.sourceUrl})` : `**${item.title}**`;
      const isNew = newKeys && newKeys.has(itemKey(item));
      lines.push(`- **${label}** — ${link}${isNew ? ' 🆕' : ''}`);
      if (item.bodySummary) {
        lines.push(`  > ${item.bodySummary.split('\n')[0].slice(0, 140)}`);
      }
    }
  }

  lines.push('');
  lines.push(`*Memory updated at [${context.sha?.slice(0, 7)}](${sourceUrl})*`);
  lines.push('');
  // Hidden machine-readable record of the full memory set for the next run.
  lines.push(`<!-- ${DATA_MARKER} ${encodeItems(items)} -->`);
  return lines.join('\n');
}

async function postCommitStatus(repo, sha, related, sourceUrl, token) {
  const description = related.length === 0
    ? 'No related prior context found'
    : `Found ${related.length} related item${related.length === 1 ? '' : 's'}: ${related[0].title}`.slice(0, 140);

  await githubRequest('POST', `/repos/${repo}/statuses/${sha}`, {
    state: 'success',
    context: 'Redis Repository Memory',
    description,
    target_url: sourceUrl,
  }, token);
  console.log(`posted_commit_status sha=${sha?.slice(0, 7)} related=${related.length}`);
}

// Find the single marked comment, merge the current findings into whatever it
// already recorded, and update it in place (or create it the first time).
async function postOrUpdatePrComment(repo, prNumber, related, context, sourceUrl, token) {
  const comments = await githubRequest('GET', `/repos/${repo}/issues/${prNumber}/comments`, null, token);
  const existing = comments.find(c => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER));

  const priorItems = existing ? extractStoredItems(existing.body) : [];
  const { merged, newKeys } = mergeItems(priorItems, related);
  const body = buildMarkdown(merged, context, sourceUrl, newKeys);

  if (existing) {
    await githubRequest('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body }, token);
    console.log(`updated_comment_id=${existing.id} pr=${prNumber} total=${merged.length} new=${newKeys.size}`);
  } else {
    const created = await githubRequest('POST', `/repos/${repo}/issues/${prNumber}/comments`, { body }, token);
    console.log(`created_comment_id=${created.id} pr=${prNumber} total=${merged.length}`);
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;

  if (!token) {
    console.error('GITHUB_TOKEN is not set');
    process.exit(1);
  }
  if (!repo) {
    console.error('GITHUB_REPOSITORY is not set');
    process.exit(1);
  }

  const { context, related, sourceUrl } = JSON.parse(
    fs.readFileSync('/tmp/memory_results.json', 'utf8')
  );

  if (context.prNumber) {
    // A single comment per PR, updated in place on every event (including
    // `synchronize`), accumulating newly-discovered memories.
    await postOrUpdatePrComment(repo, context.prNumber, related, context, sourceUrl, token);
  } else {
    // Post commit status so results are visible on the commit without opening Actions
    await postCommitStatus(repo, context.sha, related, sourceUrl, token);

    const markdown = buildMarkdown(related, context, sourceUrl, null);
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      fs.appendFileSync(summaryPath, markdown + '\n');
    } else {
      process.stdout.write(markdown + '\n');
    }
    console.log(`posted_to=step_summary related=${related.length}`);
  }
}

main().catch(err => {
  console.error('post_comment failed:', err.message);
  process.exit(1);
});
