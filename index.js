const core = require("@actions/core");
const github = require("@actions/github");
const { minimatch } = require("minimatch");

const MARKER = "<!-- analyze-pr-size:v0 -->";

function toBool(s, def) {
  if (s === undefined || s === null || s === "") return def;
  return /^(true|yes|1|on)$/i.test(String(s).trim());
}

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

const SIZE_LABEL_PREFIX = "size:";

async function applySizeLabel(octokit, { owner, repo, prNumber, size }) {
  const targetLabel = SIZE_LABEL_PREFIX + size;

  const { data: currentLabels } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100
  });

  const staleLabels = currentLabels.filter(
    (l) => l.name.startsWith(SIZE_LABEL_PREFIX) && l.name !== targetLabel
  );

  for (const label of staleLabels) {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: prNumber,
      name: label.name
    });
  }

  const alreadyApplied = currentLabels.some((l) => l.name === targetLabel);
  if (!alreadyApplied) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: [targetLabel]
    });
  }
}

const DEFAULT_IGNORE = "dist/**,*.min.js,*.min.css,package-lock.json,yarn.lock,pnpm-lock.yaml,*.generated.*";

function parseIgnorePatterns(raw) {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function filterIgnoredFiles(files, patterns) {
  if (patterns.length === 0) return { counted: files, ignoredCount: 0 };

  const counted = [];
  let ignoredCount = 0;

  for (const f of files) {
    const ignored = patterns.some((p) => minimatch(f.filename, p, { matchBase: true }));
    if (ignored) {
      ignoredCount++;
    } else {
      counted.push(f);
    }
  }

  return { counted, ignoredCount };
}

function topChangedDirectories(files, maxDepth, limit) {
  const dirMap = new Map();

  for (const f of files) {
    const segments = f.filename.split("/");
    const dir = segments.length <= maxDepth
      ? segments.slice(0, -1).join("/") || "."
      : segments.slice(0, maxDepth).join("/");
    const prev = dirMap.get(dir) || { files: 0, lines: 0 };
    prev.files += 1;
    prev.lines += (f.additions || 0) + (f.deletions || 0);
    dirMap.set(dir, prev);
  }

  return [...dirMap.entries()]
    .sort((a, b) => b[1].lines - a[1].lines)
    .slice(0, limit)
    .map(([dir, stats]) => ({ dir, ...stats }));
}

function formatDirectoryTable(dirs) {
  if (dirs.length === 0) return "";
  let table = "\n**Top changed directories:**\n\n";
  table += "| Directory | Files | Lines |\n";
  table += "|-----------|------:|------:|\n";
  for (const d of dirs) {
    table += `| \`${d.dir}\` | ${d.files} | ${fmt(d.lines)} |\n`;
  }
  return table;
}

function buildSplitRecommendation(files, size) {
  if (size !== "L" && size !== "XL") return "";

  const topDirMap = new Map();
  for (const f of files) {
    const dir = f.filename.split("/").slice(0, 2).join("/") || ".";
    const prev = topDirMap.get(dir) || 0;
    topDirMap.set(dir, prev + (f.additions || 0) + (f.deletions || 0));
  }

  const sorted = [...topDirMap.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return "";

  const parts = [];
  parts.push("\n**Split recommendation:** This PR is large — consider splitting it:");
  const top3 = sorted.slice(0, 3);
  for (const [dir, lines] of top3) {
    parts.push(`- \`${dir}\` (${fmt(lines)} lines)`);
  }
  parts.push("");
  return parts.join("\n");
}

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(n);
}

async function run() {
  try {
    const token = core.getInput("github_token", { required: true });

    const maxFiles = clampInt(core.getInput("max_files"), 500, 1, 5000);
    const addLabel = toBool(core.getInput("add_label"), false);
    const stepSummary = toBool(core.getInput("step_summary"), false);
    const ignoreRaw = core.getInput("ignore_patterns") || DEFAULT_IGNORE;
    const ignorePatterns = parseIgnorePatterns(ignoreRaw);

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

    const allFiles = await listAllPRFiles(octokit, {
      owner,
      repo,
      pull_number: prNumber,
      maxFiles
    });

    const { counted: files, ignoredCount } = filterIgnoredFiles(allFiles, ignorePatterns);

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

    const topDirs = topChangedDirectories(files, 2, 5);
    const dirSection = formatDirectoryTable(topDirs);
    const splitSection = buildSplitRecommendation(files, size);

    const body =
      `### PR Size Summary\n${MARKER}\n\n` +
      `Files changed: **${fmt(fileCount)}**\n\n` +
      `Lines added: **+${fmt(additions)}**  \n` +
      `Lines removed: **-${fmt(deletions)}**  \n` +
      `Total changed: **${fmt(totalChanged)}**\n\n` +
      `Size: **${size}**\n` +
      (ignoredCount > 0 ? `_(${ignoredCount} generated/lock file${ignoredCount === 1 ? "" : "s"} excluded)_\n` : "") +
      dirSection +
      splitSection + `\n` +
      `_Notes: size is based on the larger of file-count bucket and line-change bucket._\n`;

    const res = await upsertComment(octokit, {
      owner,
      repo,
      issue_number: prNumber,
      body
    });

    core.info(res.updated ? "Updated PR size comment." : "Created PR size comment.");
    core.info(`Comment: ${res.url}`);

    if (stepSummary) {
      await core.summary.addRaw(body).write();
      core.info("Wrote step summary.");
    }

    if (addLabel) {
      await applySizeLabel(octokit, { owner, repo, prNumber, size });
      core.info(`Applied label: ${SIZE_LABEL_PREFIX}${size}`);
    }
  } catch (err) {
    core.setFailed(err?.message || String(err));
  }
}

run();