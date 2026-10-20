import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Recognize only CodeRabbit's current-head, machine-delimited clean-review coverage. */
export function hasReviewedWalkthrough(comments, head) {
  return (comments ?? []).some((comment) => {
    if (
      comment.author?.login !== 'coderabbitai' ||
      comment.author?.__typename !== 'Bot' ||
      !Object.hasOwn(comment, 'editor') ||
      !Object.hasOwn(comment, 'lastEditedAt') ||
      !(
        (comment.editor === null && comment.lastEditedAt === null) ||
        (comment.editor?.login === 'coderabbitai' &&
          comment.editor?.__typename === 'Bot')
      ) ||
      !comment.body?.startsWith(
        '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->',
      )
    )
      return false;
    const starts = comment.body.split('\n<!-- final_review_risk_start -->\n');
    if (starts.length !== 2) return false;
    const ends = starts[1].split('\n<!-- final_review_risk_end -->');
    if (ends.length !== 2) return false;
    const markers = [
      ...ends[0].matchAll(
        /^<!-- final_review_risk_coverage:(\{[^\r\n]+\}) -->$/gm,
      ),
    ];
    if (markers.length !== 1) return false;
    try {
      const coverage = JSON.parse(markers[0][1]);
      return (
        coverage.sourceCommitId === head &&
        coverage.coveredCommitId === head &&
        coverage.kind === 'reviewed'
      );
    } catch {
      return false;
    }
  });
}

/** A gate reports evidence; it never merges, approves or changes protection. */
export function evaluate(value, policy) {
  const reasons = [];
  const { pr, final, native, run, jobs = [], reviews = [], status } = value;
  const sha = pr?.head?.sha;
  if (value.evidenceChanged)
    reasons.push(
      'CI/review evidence changed during collection; rerun for current state',
    );
  if (
    policy.mode !== 'manual' ||
    policy.base !== 'main' ||
    policy.workflow !== 'ci.yml' ||
    !Array.isArray(policy.jobs) ||
    !policy.jobs.length ||
    new Set(policy.jobs).size !== policy.jobs.length
  )
    throw new Error('Invalid gate policy');
  if (
    !pr ||
    pr.state !== 'open' ||
    pr.draft ||
    pr.base?.ref !== policy.base ||
    pr.base?.repo?.full_name !== policy.repository ||
    pr.head?.repo?.full_name !== policy.repository
  )
    reasons.push(
      'Requires an open, non-draft, same-repository PR targeting main',
    );
  if (
    !/^[0-9a-f]{40}$/.test(sha ?? '') ||
    !/^[0-9a-f]{40}$/.test(pr?.base?.sha ?? '') ||
    final?.head?.sha !== sha ||
    final?.base?.sha !== pr?.base?.sha ||
    final?.base?.ref !== policy.base ||
    final?.head?.repo?.full_name !== policy.repository ||
    final?.base?.repo?.full_name !== policy.repository ||
    final?.state !== 'open' ||
    final?.draft !== false
  )
    reasons.push('Candidate changed or its revision is unknown');
  if (
    native?.headRefOid !== sha ||
    native?.baseRefOid !== pr?.base?.sha ||
    native?.mergeStateStatus !== 'CLEAN' ||
    native?.reviewThreads?.pageInfo?.hasNextPage !== false ||
    !Array.isArray(native?.reviewThreads?.nodes) ||
    native.reviewThreads.nodes.some((thread) => !thread.isResolved)
  )
    reasons.push(
      'Native merge requirements or review conversations are blocked/stale/unknown',
    );
  if (
    !Number.isSafeInteger(run?.run_attempt) ||
    run.run_attempt < 1 ||
    run?.head_sha !== sha ||
    run?.event !== 'pull_request' ||
    run?.path !== `.github/workflows/${policy.workflow}` ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success' ||
    !run?.pull_requests?.some(
      (item) =>
        item.number === pr?.number &&
        item.base?.sha === pr?.base?.sha &&
        item.head?.sha === sha,
    )
  )
    reasons.push('Latest matching PR CI run has not succeeded');
  for (const name of policy.jobs) {
    const matching = jobs.filter((job) => job.name === name);
    if (
      matching.length !== 1 ||
      matching[0].status !== 'completed' ||
      matching[0].conclusion !== 'success'
    )
      reasons.push(`Required CI job has not succeeded: ${name}`);
  }
  const botReviews = reviews
    .filter(
      (review) =>
        review.user?.login === 'coderabbitai[bot]' &&
        review.user?.type === 'Bot' &&
        review.commit_id === sha,
    )
    .sort((a, b) => b.id - a.id);
  const bot = botReviews.find((review) =>
    review.body?.includes('<!-- coderabbit-review-publication v1 '),
  );
  const published =
    bot &&
    ['COMMENTED', 'APPROVED'].includes(bot.state) &&
    !/review skipped|rate.limit|review failed/i.test(bot.body);
  if (!published && !hasReviewedWalkthrough(value.walkthroughs, sha))
    reasons.push('No recognized completed CodeRabbit review of this HEAD');
  const approval = botReviews.find((review) =>
    ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state),
  );
  if (approval?.state !== 'APPROVED')
    reasons.push('CodeRabbit has not approved this HEAD');
  const completion = status?.statuses?.find(
    (item) => item.context === 'CodeRabbit',
  );
  if (
    status?.sha !== sha ||
    completion?.state !== 'success' ||
    completion?.description !== 'Review completed'
  )
    reasons.push('CodeRabbit completion status is missing or unrecognized');
  const decisions = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id))
    if (['APPROVED', 'CHANGES_REQUESTED'].includes(review.state))
      decisions.set(review.user?.login, review.state);
  if ([...decisions.values()].includes('CHANGES_REQUESTED'))
    reasons.push('A reviewer still requests changes');
  return {
    pr: pr?.number ?? null,
    head: sha ?? null,
    base: pr?.base?.sha ?? null,
    readyForHumanMerge: reasons.length === 0,
    canMerge: false,
    authorization: 'manual-only',
    reasons,
  };
}

/** Bounded complete evidence; truncation and network errors never become a pass. */
export async function list(client, path, key) {
  const result = [];
  for (let page = 1; page <= 30; page++) {
    const response = await client.get(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    const items = key ? response[key] : response;
    if (!Array.isArray(items)) throw new Error('Invalid paginated evidence');
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error('Evidence exceeds pagination limit');
}

/** Read mutable evidence twice: candidate identity alone does not detect reruns/reviews. */
async function collect(client, pr, policy) {
  const root = `/repos/${policy.repository}`;
  const number = pr.number;
  const sha = pr.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('Invalid HEAD');
  const [runs, reviews, status, native] = await Promise.all([
    list(
      client,
      `${root}/actions/workflows/${policy.workflow}/runs?event=pull_request&head_sha=${sha}`,
      'workflow_runs',
    ),
    list(client, `${root}/pulls/${number}/reviews`),
    client.get(`${root}/commits/${sha}/status`),
    client.native(policy.repository, number),
  ]);
  const run = runs
    .filter(
      (item) =>
        item.head_sha === sha &&
        item.pull_requests?.some((item) => item.number === number),
    )
    .sort((a, b) => b.id - a.id)[0];
  const jobs = run
    ? await list(
        client,
        `${root}/actions/runs/${run.id}/jobs?filter=latest`,
        'jobs',
      )
    : [];
  return {
    native,
    run,
    jobs,
    reviews,
    status,
    walkthroughs: native?.walkthroughs ?? [],
  };
}

/** Report only stable, current candidate/base and mutable evidence snapshots. */
export async function observe(client, number, policy) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('Invalid PR number');
  const root = `/repos/${policy.repository}`;
  const pr = await client.get(`${root}/pulls/${number}`);
  const first = await collect(client, pr, policy);
  const second = await collect(client, pr, policy);
  const final = await client.get(`${root}/pulls/${number}`);
  return evaluate(
    {
      pr,
      final,
      ...second,
      evidenceChanged: JSON.stringify(first) !== JSON.stringify(second),
    },
    policy,
  );
}

/** Fixed-host read-only transport; no PR text, artifacts or candidate code is executed. */
export function githubReader(token, fetcher = fetch) {
  if (!token) throw new Error('GITHUB_TOKEN required');
  const request = async (path, query) => {
    const response = await fetcher(`https://api.github.com${path}`, {
      method: query ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(query ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(query ? { body: JSON.stringify(query) } : {}),
    });
    if (!response.ok)
      throw new Error(`GitHub evidence unavailable (${response.status})`);
    const value = await response.json();
    if (value.errors) throw new Error('Incomplete GraphQL evidence');
    return value;
  };
  return {
    get: (path) => {
      if (!path.startsWith('/repos/')) throw new Error('Unsupported read');
      return request(path);
    },
    native: async (repository, number) => {
      const [owner, name] = repository.split('/');
      const response = await request('/graphql', {
        query: `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid mergeStateStatus comments(first:100){nodes{body author{login __typename} editor{login __typename} lastEditedAt} pageInfo{hasNextPage}} reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}}}}`,
        variables: { owner, name, number },
      });
      const pr = response.data?.repository?.pullRequest;
      return {
        ...pr,
        walkthroughs:
          pr?.comments?.pageInfo?.hasNextPage === false
            ? pr.comments.nodes
            : [],
      };
    },
  };
}

/** Resolve event identity from GitHub metadata, never descriptions or labels. */
export async function candidates(event, client, policy) {
  if (event.pull_request) return [event.pull_request.number];
  if (event.inputs?.pr) {
    if (!/^[1-9]\d*$/.test(event.inputs.pr))
      throw new Error('Invalid dispatch PR');
    return [Number(event.inputs.pr)];
  }
  if (event.workflow_run?.pull_requests?.length)
    return event.workflow_run.pull_requests.map((item) => item.number);
  const sha =
    event.sha ?? event.check_run?.head_sha ?? event.workflow_run?.head_sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('No event candidate');
  const open = await list(
    client,
    `/repos/${policy.repository}/pulls?state=open`,
  );
  return open.filter((pr) => pr.head?.sha === sha).map((pr) => pr.number);
}

/** Run the trusted-main observer without exposing tokens or untrusted error text. */
async function main() {
  const policy = JSON.parse(
    await readFile(
      new URL('../.github/merge-policy.json', import.meta.url),
      'utf8',
    ),
  );
  if (
    process.env.GITHUB_REPOSITORY !== policy.repository ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  )
    throw new Error('Trusted repository main only');
  const client = githubReader(process.env.GITHUB_TOKEN);
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'),
  );
  const reports = [];
  for (const number of new Set(await candidates(event, client, policy)))
    reports.push(await observe(client, number, policy));
  const text = JSON.stringify(
    { policy: process.env.GITHUB_SHA, reports },
    null,
    2,
  );
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## PR merge readiness\n\nEvidence only; merging remains manual.\n\n\`\`\`json\n${text}\n\`\`\`\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    // Only messages authored by this module may reach Actions logs. Native
    // fetch/JSON/filesystem errors can contain paths or source excerpts.
    const known = new Set([
      'Invalid gate policy',
      'Invalid paginated evidence',
      'Evidence exceeds pagination limit',
      'Invalid HEAD',
      'Invalid PR number',
      'GITHUB_TOKEN required',
      'Incomplete GraphQL evidence',
      'Unsupported read',
      'Invalid dispatch PR',
      'No event candidate',
      'Trusted repository main only',
    ]);
    const message = typeof error?.message === 'string' ? error.message : '';
    const reason =
      known.has(message) ||
      /^GitHub evidence unavailable \(\d{3}\)$/.test(message)
        ? message
        : 'Native read or parsing failed';
    console.error(
      `Merge gate could not establish readiness: ${reason}. No merge authorization.`,
    );
    process.exitCode = 1;
  });
