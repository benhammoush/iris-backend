import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluate,
  observe,
  githubReader,
  candidates,
  hasReviewedWalkthrough,
} from './merge-gate.mjs';

const policy = JSON.parse(
  readFileSync(new URL('../.github/merge-policy.json', import.meta.url)),
);
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
/** Complete current-head/base evidence with no authority to execute a merge. */
function fixture() {
  const pr = {
    number: 7,
    state: 'open',
    draft: false,
    head: { sha: head, repo: { full_name: policy.repository } },
    base: { sha: base, ref: 'main', repo: { full_name: policy.repository } },
  };
  return {
    pr,
    final: structuredClone(pr),
    native: {
      headRefOid: head,
      baseRefOid: base,
      mergeStateStatus: 'CLEAN',
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    },
    run: {
      id: 1,
      run_attempt: 1,
      head_sha: head,
      event: 'pull_request',
      path: '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: 'success',
      pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
    },
    jobs: policy.jobs.map((name) => ({
      name,
      status: 'completed',
      conclusion: 'success',
    })),
    reviews: [
      {
        id: 1,
        user: { login: 'coderabbitai[bot]', type: 'Bot' },
        commit_id: head,
        state: 'APPROVED',
        body: '<!-- coderabbit-review-publication v1 fixture -->',
      },
    ],
    status: {
      sha: head,
      statuses: [
        {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review completed',
          creator: { login: 'coderabbitai[bot]', type: 'Bot' },
        },
      ],
    },
  };
}

test('complete evidence is ready only for a human merge, never automatic authorization', () => {
  const result = evaluate(fixture(), policy);
  assert.equal(result.readyForHumanMerge, true);
  assert.equal(result.canMerge, false);
  assert.equal(result.authorization, 'manual-only');
  assert.throws(() => evaluate(fixture(), { ...policy, mode: 'auto' }));
});

test('matching completion text from another creator cannot substitute for CodeRabbit', () => {
  for (const creator of [
    undefined,
    { login: 'maintainer', type: 'User' },
    { login: 'coderabbitai[bot]', type: 'User' },
    { login: 'other[bot]', type: 'Bot' },
  ]) {
    const value = fixture();
    value.status.statuses[0].creator = creator;
    assert.equal(evaluate(value, policy).readyForHumanMerge, false);
  }
});

test('a later dismissed bot review holds until a new current-head approval', () => {
  const value = fixture();
  value.reviews.push({ ...value.reviews[0], id: 2, state: 'DISMISSED' });
  assert.equal(evaluate(value, policy).readyForHumanMerge, false);
  value.reviews.push({ ...value.reviews[0], id: 3 });
  assert.equal(evaluate(value, policy).readyForHumanMerge, true);
});

test('workflow path revision suffix does not replace independent identity checks', () => {
  const value = fixture();
  value.run.path += '@refs/pull/8/merge';
  assert.equal(evaluate(value, policy).readyForHumanMerge, true);
  for (const path of [undefined, '.github/workflows/fake.yml@main']) {
    value.run.path = path;
    assert.equal(evaluate(value, policy).readyForHumanMerge, false);
  }
  value.run.path = `.github/workflows/${policy.workflow}@main`;
  value.run.head_sha = base;
  assert.equal(evaluate(value, policy).readyForHumanMerge, false);
});

test('missing, stale, conflicting and hostile evidence fails closed', () => {
  for (const change of [
    (v) => {
      v.pr.draft = true;
    },
    (v) => {
      v.reviews[0].state = 'COMMENTED';
    },
    (v) => {
      v.pr.head.repo.full_name = 'other/fork';
    },
    (v) => {
      v.final.head.sha = base;
    },
    (v) => {
      v.final.base.sha = head;
    },
    (v) => {
      v.final.state = 'closed';
    },
    (v) => {
      v.native.mergeStateStatus = 'UNKNOWN';
    },
    (v) => {
      v.native.reviewThreads.pageInfo.hasNextPage = true;
    },
    (v) => {
      v.native.reviewThreads.nodes = [{ isResolved: false }];
    },
    (v) => {
      v.jobs = [];
    },
    (v) => {
      v.jobs.push(v.jobs[0]);
    },
    (v) => {
      v.jobs[0].conclusion = 'skipped';
    },
    (v) => {
      v.run.event = 'push';
    },
    (v) => {
      v.run.head_sha = base;
    },
    (v) => {
      v.run.path = '.github/workflows/fake.yml';
    },
    (v) => {
      v.run.pull_requests[0].base.sha = head;
    },
    (v) => {
      v.evidenceChanged = true;
    },
    (v) => {
      v.reviews[0].commit_id = base;
    },
    (v) => {
      v.reviews[0].body = 'Approved';
    },
    (v) => {
      v.reviews[0].body += ' review skipped';
    },
    (v) => {
      v.status.statuses = [];
    },
    (v) => {
      v.reviews.push({
        id: 2,
        user: { login: 'owner' },
        state: 'CHANGES_REQUESTED',
      });
    },
  ]) {
    const value = fixture();
    change(value);
    assert.equal(evaluate(value, policy).readyForHumanMerge, false);
  }
});

test('a separate bot approval needs the completed publication on the same HEAD', () => {
  const value = fixture();
  value.reviews[0].state = 'COMMENTED';
  value.reviews.push({
    ...value.reviews[0],
    id: 2,
    state: 'APPROVED',
    body: '',
  });
  assert.equal(evaluate(value, policy).readyForHumanMerge, true);
  value.reviews[1].commit_id = base;
  assert.equal(evaluate(value, policy).readyForHumanMerge, false);
  value.reviews[1].commit_id = head;
  value.reviews[1].state = 'CHANGES_REQUESTED';
  assert.equal(evaluate(value, policy).readyForHumanMerge, false);
});

test('blank clean approvals require trusted reviewed coverage of the exact current HEAD', () => {
  const comment = {
    author: { login: 'coderabbitai', __typename: 'Bot' },
    editor: null,
    lastEditedAt: null,
    body:
      '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
      '<!-- final_review_risk_start -->\n' +
      `<!-- final_review_risk_coverage:${JSON.stringify({ sourceCommitId: head, coveredCommitId: head, kind: 'reviewed' })} -->\n` +
      '<!-- final_review_risk_end -->',
  };
  assert.equal(hasReviewedWalkthrough([comment], head), true);
  assert.equal(
    hasReviewedWalkthrough(
      [
        {
          ...comment,
          editor: { login: 'coderabbitai', __typename: 'Bot' },
          lastEditedAt: '2026-10-20T00:00:00Z',
        },
      ],
      head,
    ),
    true,
  );
  for (const altered of [
    { ...comment, author: { ...comment.author, __typename: 'User' } },
    { ...comment, author: { login: 'another-bot', __typename: 'Bot' } },
    {
      ...comment,
      editor: { login: 'maintainer', __typename: 'User' },
      lastEditedAt: '2026-10-20T00:00:00Z',
    },
    { ...comment, editor: undefined },
    { ...comment, editor: null, lastEditedAt: '2026-10-20T00:00:00Z' },
    { ...comment, body: comment.body.replaceAll(head, base) },
    {
      ...comment,
      body: comment.body.replace(
        '"kind":"reviewed"',
        '"kind":"carried-forward"',
      ),
    },
    {
      ...comment,
      body: comment.body.replace(
        '<!-- final_review_risk_coverage:',
        '> <!-- final_review_risk_coverage:',
      ),
    },
    {
      ...comment,
      body: comment.body.replace('"sourceCommitId"', 'invalid-json'),
    },
    { ...comment, body: comment.body + '\n<!-- final_review_risk_start -->\n' },
  ])
    assert.equal(hasReviewedWalkthrough([altered], head), false);
  const value = fixture();
  value.reviews[0].body = '';
  assert.equal(evaluate(value, policy).readyForHumanMerge, false);
  value.walkthroughs = [comment];
  assert.equal(evaluate(value, policy).readyForHumanMerge, true);
  value.reviews[0].state = 'COMMENTED';
  assert.equal(evaluate(value, policy).readyForHumanMerge, false);
  value.reviews[0].state = 'APPROVED';
  value.status.statuses[0].state = 'pending';
  assert.equal(evaluate(value, policy).readyForHumanMerge, false);
});

test('collector checks a complete current candidate and detects mid-read pushes', async () => {
  for (const race of [false, true]) {
    const value = fixture();
    let reads = 0;
    const client = {
      native: async () => value.native,
      get: async (path) => {
        if (path.endsWith('/pulls/7'))
          return ++reads > 1 && race
            ? { ...value.pr, head: { ...value.pr.head, sha: base } }
            : value.pr;
        if (path.includes('/workflows/ci.yml/runs?'))
          return { workflow_runs: [value.run] };
        if (path.includes('/runs/1/jobs?')) return { jobs: value.jobs };
        if (path.includes('/reviews?')) return value.reviews;
        if (path.includes('/comments?')) return [];
        if (path.includes('/statuses?')) return value.status.statuses;
        throw new Error('Unexpected endpoint');
      },
    };
    assert.equal((await observe(client, 7, policy)).readyForHumanMerge, !race);
  }
});

test('same-head CI reruns, new reviews, statuses and conversations invalidate collected evidence', async () => {
  for (const kind of ['rerun', 'review', 'status', 'thread']) {
    const value = fixture();
    let round = 0;
    const changed = () => {
      const copy = structuredClone(value);
      if (round > 1) {
        if (kind === 'rerun') {
          copy.run.run_attempt = 2;
          copy.run.status = 'in_progress';
        }
        if (kind === 'review')
          copy.reviews.push({
            id: 2,
            user: { login: 'maintainer' },
            state: 'CHANGES_REQUESTED',
          });
        if (kind === 'status') copy.status.statuses[0].state = 'pending';
        if (kind === 'thread')
          copy.native.reviewThreads.nodes.push({ isResolved: false });
      }
      return copy;
    };
    const client = {
      native: async () => changed().native,
      get: async (path) => {
        if (path.endsWith('/pulls/7')) return structuredClone(value.pr);
        if (path.includes('/workflows/ci.yml/runs?')) {
          round++;
          return { workflow_runs: [changed().run] };
        }
        if (path.includes('/runs/1/jobs?')) return { jobs: changed().jobs };
        if (path.includes('/reviews?')) return changed().reviews;
        if (path.includes('/comments?')) return [];
        if (path.includes('/statuses?')) return changed().status.statuses;
        throw new Error('Unexpected endpoint');
      },
    };
    const report = await observe(client, 7, policy);
    assert.equal(report.readyForHumanMerge, false, kind);
    assert.ok(
      report.reasons.some((reason) =>
        reason.includes('changed during collection'),
      ),
      kind,
    );
  }
});

test('transport exposes reads and one fixed GraphQL query, with no write/retry/redirect', async () => {
  const calls = [];
  const client = githubReader('fixture', async (url, options) => {
    calls.push({ url, ...options });
    return {
      ok: true,
      json: async () => ({ data: { repository: { pullRequest: {} } } }),
    };
  });
  await client.get(`/repos/${policy.repository}/pulls/7`);
  await client.native(policy.repository, 7);
  assert.deepEqual(
    calls.map((v) => v.method),
    ['GET', 'POST'],
  );
  assert.ok(calls.every((v) => v.redirect === 'error'));
  assert.doesNotMatch(JSON.parse(calls[1].body).query, /mutation/);
  assert.throws(() => client.get('/elsewhere'));
  await assert.rejects(
    candidates({ inputs: { pr: '7; bad' } }, client, policy),
  );
});

test('workflow only runs trusted main with read-only permissions and no candidate installs', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/merge-eligibility.yml', import.meta.url),
    'utf8',
  );
  assert.ok(workflow.includes("if: github.ref == 'refs/heads/main'"));
  assert.ok(workflow.includes('ref: ${{ github.sha }}'));
  assert.ok(workflow.includes('persist-credentials: false'));
  assert.doesNotMatch(
    workflow,
    /: write|secrets\.|npm ci|download-artifact|pull_request\.head/,
  );
});

test('GraphQL walkthrough collection preserves editor provenance and rejects truncated evidence', async () => {
  const comment = {
    body: 'fixture',
    author: { login: 'coderabbitai', __typename: 'Bot' },
    editor: { login: 'maintainer', __typename: 'User' },
    lastEditedAt: '2026-10-20T00:00:00Z',
  };
  for (const truncated of [false, true]) {
    const client = githubReader('fixture', async () => ({
      ok: true,
      json: async () => ({
        data: {
          repository: {
            pullRequest: {
              comments: {
                nodes: [comment],
                pageInfo: { hasNextPage: truncated },
              },
            },
          },
        },
      }),
    }));
    const native = await client.native(policy.repository, 7);
    assert.deepEqual(native.walkthroughs, truncated ? [] : [comment]);
  }
});

test('CLI prints a safe failure reason before any API access on an untrusted ref', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./merge-gate.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: policy.repository,
        GITHUB_REF: 'refs/heads/task',
      },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Trusted repository main only/);
  assert.doesNotMatch(result.stderr, /Bearer|Authorization|at main/);
});
