const core = require("@actions/core");

function toBool(s, def = false) {
  if (s == null) return def;
  const v = String(s).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return def;
}

function clampInt(val, def, min, max) {
  const n = parseInt(String(val ?? def), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

async function upsertComment(octokit, { owner, repo, issue_number, body, marker }) {
  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number,
    per_page: 100
  });

  const existing = comments.data.find((c) => (c.body || "").includes(marker));
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body
    });
    return { updated: true, url: existing.html_url };
  }

  const created = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body
  });
  return { updated: false, url: created.data.html_url };
}

async function deleteCommentByMarker(octokit, { owner, repo, issue_number, marker }) {
  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number,
    per_page: 100
  });

  const existing = comments.data.find((c) => (c.body || "").includes(marker));
  if (existing) {
    await octokit.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: existing.id
    });
    core.info(`Deleted old comment with marker ${marker}`);
    return true;
  }
  return false;
}

async function listAllPRFiles(octokit, { owner, repo, pull_number, maxFiles }) {
  const files = [];
  let page = 1;

  while (files.length < maxFiles) {
    const resp = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number,
      per_page: 100,
      page
    });

    if (resp.data.length === 0) break;

    for (const f of resp.data) {
      files.push(f);
      if (files.length >= maxFiles) break;
    }

    if (resp.data.length < 100) break;
    page += 1;
  }

  return files;
}

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(n);
}

module.exports = {
  toBool,
  clampInt,
  upsertComment,
  deleteCommentByMarker,
  listAllPRFiles,
  fmt
};
