const core = require("@actions/core");
const github = require("@actions/github");

const MARKER = "<!-- analyze-pr-size:v0 -->";

function clampInt(val, def, min, max) {
  const n = parseInt(String(val ?? def), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function bucketByThresholds(value, thresholds) {
  // thresholds = [{name:"XS", max:...}, ...], last implied "XL"
  for (const t of thresholds) {
    if (value <= t.max) return t.name;
  }
  return "XL";
}

const SIZE_ORDER = ["XS", "S", "M", "L", "XL"];
function maxBucket(a, b) {
  return SIZE_ORDER[Math.max(SIZE_ORDER.indexOf(a), SIZE_ORDER.indexOf(b))];
}

async function upsertComment(octokit, { owner, repo, issue_number, body }) {
  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number,
    per_page: 100
  });

  const existing = comments.data.find((c) => (c.body || "").includes(MARKER));
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

async function run() {
  try {
    const token = core.getInput("github_token", { required: true });

    const maxFiles = clampInt(core.getInput("max_files"), 500, 1, 5000);

    const xsLines = clampInt(core.getInput("xs_lines"), 50, 1, 1000000);
    const sLines = clampInt(core.getInput("s_lines"), 200, xsLines, 1000000);
    const mLines = clampInt(core.getInput("m_lines"), 500, sLines, 1000000);
    const lLines = clampInt(core.getInput("l_lines"), 1000, mLines, 1000000);

    const xsFiles = clampInt(core.getInput("xs_files"), 2, 1, 1000000);
    const sFiles = clampInt(core.getInput("s_files"), 5, xsFiles, 1000000);
    const mFiles = clampInt(core.getInput("m_files"), 15, sFiles, 1000000);
    const lFiles = clampInt(core.getInput("l_files"), 30, mFiles, 1000000);

    const ctx = github.context;
    if (ctx.eventName !== "pull_request" || !ctx.payload.pull_request) {
      core.info("Not a pull_request event; skipping.");
      return;
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = ctx.repo;
    const prNumber = ctx.payload.pull_request.number;

    const files = await listAllPRFiles(octokit, {
      owner,
      repo,
      pull_number: prNumber,
      maxFiles
    });

    let additions = 0;
    let deletions = 0;

    for (const f of files) {
      additions += f.additions || 0;
      deletions += f.deletions || 0;
    }

    const fileCount = files.length;
    const totalChanged = additions + deletions;

    const lineBucket = bucketByThresholds(totalChanged, [
      { name: "XS", max: xsLines },
      { name: "S", max: sLines },
      { name: "M", max: mLines },
      { name: "L", max: lLines }
    ]);

    const fileBucket = bucketByThresholds(fileCount, [
      { name: "XS", max: xsFiles },
      { name: "S", max: sFiles },
      { name: "M", max: mFiles },
      { name: "L", max: lFiles }
    ]);

    const size = maxBucket(lineBucket, fileBucket);

    const body =
      `### PR Size Summary\n${MARKER}\n\n` +
      `Files changed: **${fmt(fileCount)}**\n\n` +
      `Lines added: **+${fmt(additions)}**  \n` +
      `Lines removed: **-${fmt(deletions)}**  \n` +
      `Total changed: **${fmt(totalChanged)}**\n\n` +
      `Size: **${size}**\n\n` +
      `_Notes: size is based on the larger of file-count bucket and line-change bucket._\n`;

    const res = await upsertComment(octokit, {
      owner,
      repo,
      issue_number: prNumber,
      body
    });

    core.info(res.updated ? "Updated PR size comment." : "Created PR size comment.");
    core.info(`Comment: ${res.url}`);
  } catch (err) {
    core.setFailed(err?.message || String(err));
  }
}

run();