const { minimatch } = require("minimatch");
const { fmt } = require("./utils");

const SIZE_ORDER = ["XS", "S", "M", "L", "XL"];

function bucketByThresholds(value, thresholds) {
  for (const t of thresholds) {
    if (value <= t.max) return t.name;
  }
  return "XL";
}

function maxBucket(a, b) {
  return SIZE_ORDER[Math.max(SIZE_ORDER.indexOf(a), SIZE_ORDER.indexOf(b))];
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

function analyzeSize({ files, thresholds }) {
  let additions = 0;
  let deletions = 0;

  for (const f of files) {
    additions += f.additions || 0;
    deletions += f.deletions || 0;
  }

  const fileCount = files.length;
  const totalChanged = additions + deletions;

  const lineBucket = bucketByThresholds(totalChanged, [
    { name: "XS", max: thresholds.xsLines },
    { name: "S", max: thresholds.sLines },
    { name: "M", max: thresholds.mLines },
    { name: "L", max: thresholds.lLines }
  ]);

  const fileBucket = bucketByThresholds(fileCount, [
    { name: "XS", max: thresholds.xsFiles },
    { name: "S", max: thresholds.sFiles },
    { name: "M", max: thresholds.mFiles },
    { name: "L", max: thresholds.lFiles }
  ]);

  const size = maxBucket(lineBucket, fileBucket);
  const topDirs = topChangedDirectories(files, 2, 5);

  return { additions, deletions, fileCount, totalChanged, size, topDirs };
}

function formatSizeSection({ additions, deletions, fileCount, totalChanged, size, ignoredCount, topDirs, files }) {
  const dirSection = formatDirectoryTable(topDirs);
  const splitSection = buildSplitRecommendation(files, size);

  let section = "";
  section += `#### Size Summary\n\n`;
  section += `Files changed: **${fmt(fileCount)}**\n\n`;
  section += `Lines added: **+${fmt(additions)}**  \n`;
  section += `Lines removed: **-${fmt(deletions)}**  \n`;
  section += `Total changed: **${fmt(totalChanged)}**\n\n`;
  section += `Size: **${size}**\n`;
  if (ignoredCount > 0) {
    section += `_(${ignoredCount} generated/lock file${ignoredCount === 1 ? "" : "s"} excluded)_\n`;
  }
  section += dirSection;
  section += splitSection;
  section += `\n_Notes: size is based on the larger of file-count bucket and line-change bucket._\n`;

  return section;
}

module.exports = {
  DEFAULT_IGNORE,
  parseIgnorePatterns,
  filterIgnoredFiles,
  analyzeSize,
  formatSizeSection,
  applySizeLabel
};
