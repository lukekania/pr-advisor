const core = require("@actions/core");
const minimatch = require("minimatch");

// -------------------- Utilities --------------------

function isBotLogin(login) {
  if (!login) return true;
  const l = login.toLowerCase();
  return login.endsWith("[bot]") || l.includes("bot") || l === "github-actions";
}

function parseCommaSeparated(s) {
  return (s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function daysAgoISO(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// -------------------- GitHub fetch helpers --------------------

async function topCommitAuthorsForPath(octokit, { owner, repo, path, sinceISO, perFileCommitCap = 30 }) {
  const resp = await octokit.rest.repos.listCommits({
    owner, repo, path, since: sinceISO, per_page: perFileCommitCap
  });

  const authors = [];
  for (const c of resp.data) {
    const login = c.author?.login || null;
    if (login && !isBotLogin(login)) authors.push(login);
  }
  return authors;
}

// -------------------- CODEOWNERS support --------------------

const CODEOWNERS_CANDIDATE_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS"
];

async function tryFetchFileText(octokit, { owner, repo, path, ref }) {
  try {
    const resp = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (!resp.data || Array.isArray(resp.data) || !resp.data.content) return null;
    const buf = Buffer.from(resp.data.content, resp.data.encoding || "base64");
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function parseCodeowners(text) {
  const rules = [];
  if (!text) return rules;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const noInline = line.split(/\s+#/)[0].trim();
    if (!noInline) continue;

    const parts = noInline.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;

    const pattern = parts[0];
    const rawOwners = parts.slice(1).map((o) => o.replace(/^@/, "").trim()).filter(Boolean);
    const owners = rawOwners.filter((o) => !isBotLogin(o));
    const teams = rawOwners.filter((o) => o.includes("/"));

    if (!owners.length) continue;
    rules.push({ pattern, owners, teams });
  }

  return rules;
}

function normalizeCodeownersPattern(pattern) {
  if (pattern.startsWith("/")) return pattern.slice(1);
  return `**/${pattern}`;
}

function ownersForFile(codeownersRules, filePath) {
  if (!codeownersRules.length) return [];
  let matchedOwners = [];

  for (const r of codeownersRules) {
    const pat = normalizeCodeownersPattern(r.pattern);
    if (minimatch(filePath, pat, { dot: true, nocase: false, matchBase: true })) {
      matchedOwners = r.owners;
    }
  }
  return matchedOwners;
}

// -------------------- Review latency scoring --------------------

async function computeReviewerLatencyHours(octokit, { owner, repo, lookbackDays, maxClosedPRs = 20 }) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const pulls = await octokit.rest.pulls.list({
    owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: maxClosedPRs
  });

  const perReviewer = new Map();

  for (const pr of pulls.data) {
    if (!pr.merged_at && !pr.closed_at) continue;
    const createdAt = new Date(pr.created_at);
    if (createdAt < since) continue;

    let reviewsResp;
    try {
      reviewsResp = await octokit.rest.pulls.listReviews({ owner, repo, pull_number: pr.number, per_page: 100 });
    } catch {
      continue;
    }

    const firstByUser = new Map();
    for (const r of reviewsResp.data) {
      const login = r.user?.login;
      if (!login || isBotLogin(login)) continue;
      if (!r.submitted_at) continue;
      const t = new Date(r.submitted_at);
      const existing = firstByUser.get(login);
      if (!existing || t < existing) firstByUser.set(login, t);
    }

    for (const [login, t] of firstByUser.entries()) {
      const hours = (t.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
      if (!Number.isFinite(hours) || hours < 0) continue;
      if (!perReviewer.has(login)) perReviewer.set(login, []);
      perReviewer.get(login).push(hours);
    }
  }

  const out = new Map();
  for (const [login, arr] of perReviewer.entries()) {
    const m = median(arr);
    if (m != null) out.set(login, m);
  }
  return out;
}

function latencyBonusHours(medianHours) {
  if (medianHours == null) return 0;
  if (medianHours <= 4) return 6;
  if (medianHours <= 12) return 4;
  if (medianHours <= 24) return 2;
  if (medianHours <= 48) return 1;
  return 0;
}

// -------------------- Review load --------------------

async function computeOpenReviewCounts(octokit, { owner, repo }) {
  const pulls = await octokit.rest.pulls.list({ owner, repo, state: "open", per_page: 100 });

  const counts = new Map();
  for (const pr of pulls.data) {
    for (const reviewer of (pr.requested_reviewers || [])) {
      const login = reviewer.login;
      if (!login) continue;
      counts.set(login, (counts.get(login) || 0) + 1);
    }
  }
  return counts;
}

function applyLoadPenalty(score, openReviews) {
  return score * (1 / (1 + openReviews / 3));
}

// -------------------- Reviewer exclusion --------------------

async function fetchExcludedReviewers(octokit, { owner, repo, ref, inputExcludes }) {
  const excluded = new Set(inputExcludes.map((s) => s.toLowerCase()));

  try {
    const text = await tryFetchFileText(octokit, { owner, repo, path: ".github/reviewer-config.yml", ref });
    if (text) {
      const inlineMatch = text.match(/exclude:\s*\[([^\]]+)\]/);
      if (inlineMatch) {
        inlineMatch[1].split(",").forEach((u) => {
          const trimmed = u.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
          if (trimmed) excluded.add(trimmed);
        });
      } else {
        const lines = text.split(/\r?\n/);
        let inExclude = false;
        for (const line of lines) {
          if (/^exclude:/i.test(line.trim())) { inExclude = true; continue; }
          if (inExclude && /^\s+-\s+/.test(line)) {
            const user = line.replace(/^\s+-\s+/, "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
            if (user) excluded.add(user);
          } else if (inExclude && /^\S/.test(line)) {
            inExclude = false;
          }
        }
      }
    }
  } catch {
    // best effort
  }

  return excluded;
}

// -------------------- Cross-repo expertise --------------------

async function fetchCrossRepoExpertise(octokit, { owner, repos, filePaths, sinceISO }) {
  const expertise = new Map();

  for (const repoName of repos) {
    for (const filePath of filePaths.slice(0, 5)) {
      try {
        const resp = await octokit.rest.repos.listCommits({
          owner, repo: repoName, path: filePath, since: sinceISO, per_page: 10
        });

        for (const c of resp.data) {
          const login = c.author?.login;
          if (!login || isBotLogin(login)) continue;
          expertise.set(login, (expertise.get(login) || 0) + 1);
        }
      } catch {
        // repo may not exist or file may not exist
      }
    }
  }

  return expertise;
}

// -------------------- Timezone awareness --------------------

function parseTimezoneOffset(tz) {
  if (!tz) return null;
  const match = tz.match(/UTC([+-]?\d+)/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

function timezoneBonus(avgHourUTC, preferredOffsetHours) {
  if (avgHourUTC == null || preferredOffsetHours == null) return 0;
  const preferredCenterUTC = (14 - preferredOffsetHours + 24) % 24;
  const diff = Math.abs(avgHourUTC - preferredCenterUTC);
  const wrappedDiff = Math.min(diff, 24 - diff);
  if (wrappedDiff <= 4) return 3;
  if (wrappedDiff <= 8) return 1;
  return 0;
}

// -------------------- Flaky reviewer detection --------------------

async function detectFlakyReviewers(octokit, { owner, repo, lookbackDays, maxPRs = 30 }) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const pulls = await octokit.rest.pulls.list({
    owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: maxPRs
  });

  const requestedCounts = new Map();
  const reviewedCounts = new Map();

  for (const pr of pulls.data) {
    if (new Date(pr.created_at) < since) continue;

    let reviewsResp;
    try {
      reviewsResp = await octokit.rest.pulls.listReviews({ owner, repo, pull_number: pr.number, per_page: 100 });
    } catch {
      continue;
    }

    const reviewed = new Set();
    for (const r of reviewsResp.data) {
      const login = r.user?.login;
      if (login) reviewed.add(login.toLowerCase());
    }

    for (const login of reviewed) {
      reviewedCounts.set(login, (reviewedCounts.get(login) || 0) + 1);
    }
  }

  const openPulls = await octokit.rest.pulls.list({ owner, repo, state: "open", per_page: 50 });

  for (const pr of openPulls.data) {
    for (const reviewer of (pr.requested_reviewers || [])) {
      const login = (reviewer.login || "").toLowerCase();
      if (login) requestedCounts.set(login, (requestedCounts.get(login) || 0) + 1);
    }
  }

  const flaky = new Set();
  for (const [login, requested] of requestedCounts) {
    const reviewed = reviewedCounts.get(login) || 0;
    if (requested >= 3 && reviewed < requested) {
      flaky.add(login);
    }
  }

  return flaky;
}

// -------------------- Ranking --------------------

function rankCandidates({ fileAuthors, prAuthor, codeownersRules, changedFiles, latencyMap, weights, crossRepoExpertise, timezoneData, requiredReviewers }) {
  const scores = new Map();
  const reasons = new Map();

  const add = (login, pts, reason) => {
    if (!login || isBotLogin(login)) return;
    if (login === prAuthor) return;
    scores.set(login, (scores.get(login) || 0) + pts);
    if (!reasons.has(login)) reasons.set(login, new Set());
    if (reason) reasons.get(login).add(reason);
  };

  for (const { authors } of fileAuthors) {
    const max = Math.min(authors.length, 10);
    for (let i = 0; i < max; i++) {
      const w = Math.max(1, 3 - i);
      add(authors[i], w * weights.commitHistory, "recent commits");
    }
  }

  if (weights.codeowners > 0 && codeownersRules.length) {
    const seen = new Set();
    for (const f of changedFiles) {
      const owners = ownersForFile(codeownersRules, f);
      for (const o of owners) {
        if (!o) continue;
        const key = `${o}::${f}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add(o, weights.codeowners, "CODEOWNERS");
      }
    }
  }

  if (weights.latency > 0 && latencyMap && latencyMap.size) {
    for (const [login, medHrs] of latencyMap.entries()) {
      const bonus = latencyBonusHours(medHrs) * weights.latency;
      if (bonus > 0) add(login, bonus, `fast reviewer (~${Math.round(medHrs)}h median)`);
    }
  }

  if (crossRepoExpertise && crossRepoExpertise.size > 0) {
    for (const [login, count] of crossRepoExpertise) {
      add(login, Math.min(count, 5), "cross-repo expertise");
    }
  }

  if (timezoneData && timezoneData.preferredOffset != null) {
    for (const [login, avgHour] of (timezoneData.avgHours || new Map())) {
      const bonus = timezoneBonus(avgHour, timezoneData.preferredOffset);
      if (bonus > 0) add(login, bonus, "timezone match");
    }
  }

  if (requiredReviewers && requiredReviewers.length > 0) {
    for (const login of requiredReviewers) {
      if (login === prAuthor || isBotLogin(login)) continue;
      const current = scores.get(login) || 0;
      if (current === 0) add(login, 10, "required reviewer");
      else add(login, 5, "required reviewer");
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([login, score]) => ({
      login,
      score,
      reasons: [...(reasons.get(login) || [])]
    }));
}

// -------------------- Confidence --------------------

function computeConfidence({ ranked, changedFiles, codeownersRules, fileAuthors }) {
  const top = ranked[0]?.score || 0;
  const second = ranked[1]?.score || 0;

  let covered = 0;
  const byFileHasSignal = new Map(changedFiles.map((f) => [f, false]));

  if (fileAuthors.length) {
    const approx = Math.min(changedFiles.length, Math.max(1, Math.floor(fileAuthors.length)));
    covered = Math.max(covered, approx);
  }

  if (codeownersRules.length) {
    for (const f of changedFiles) {
      if (ownersForFile(codeownersRules, f).length) byFileHasSignal.set(f, true);
    }
  }

  const codeownersCovered = [...byFileHasSignal.values()].filter(Boolean).length;
  covered = Math.max(covered, codeownersCovered);

  const coverageRatio = changedFiles.length ? covered / changedFiles.length : 0;
  const separation = top > 0 ? (top - second) / top : 0;

  if (top >= 12 && coverageRatio >= 0.5 && separation >= 0.25) return "High";
  if (top >= 6 && coverageRatio >= 0.25) return "Medium";
  return "Low";
}

// -------------------- Comment formatting --------------------

function formatReviewerSection({ suggestions, lookbackDays, maxFiles, fileCount, confidence, teamCoverage, showBreakdown }) {
  let section = `#### Reviewer Suggestions\n\n`;
  section +=
    `Based on:\n` +
    `- commit history in the last **${lookbackDays} days**\n` +
    `- changed files: **${Math.min(fileCount, maxFiles)}**\n` +
    `- confidence: **${confidence}**\n\n`;

  if (suggestions.length === 0) {
    section += "No strong candidates found (not enough history, no CODEOWNERS match, or only bots/author matched).\n";
    return section;
  }

  const list = suggestions
    .map((s) => {
      const why = s.reasons?.length ? ` — ${s.reasons.join(", ")}` : "";
      const loadStr = s.openReviews != null ? `, ${s.openReviews} open reviews` : "";
      return `- @${s.login} (score: ${s.score}${loadStr})${why}`;
    })
    .join("\n");

  section += list;

  if (teamCoverage && teamCoverage.length > 0) {
    section += "\n\n**Team coverage:**\n" +
      teamCoverage.map((t) => `- ${t.team}: ${t.count}/${t.total} suggestions`).join("\n") +
      "\n";
  }

  if (showBreakdown && suggestions.length > 0) {
    section += "\n\n**Signal breakdown:**\n\n";
    section += "| Reviewer | Score | Signals |\n";
    section += "|----------|------:|--------|\n";
    for (const s of suggestions) {
      const signals = s.reasons?.join(", ") || "-";
      const loadStr = s.openReviews != null ? ` (${s.openReviews} open)` : "";
      section += `| @${s.login} | ${s.score}${loadStr} | ${signals} |\n`;
    }
  }

  section += `\n_Notes: excludes PR author and bots; heuristic-based._\n`;
  return section;
}

// -------------------- Main reviewer analysis --------------------

async function analyzeReviewers(octokit, { owner, repo, prNumber, prAuthor, prHeadSha, files, reviews, config }) {
  const {
    maxReviewers, lookbackDays, maxFiles, useCodeowners, useLatency, latencyPRs,
    penalizeLoad, excludeReviewersInput, crossRepoList, requiredReviewers,
    preferTimezone, showBreakdown, detectFlaky
  } = config;

  const changedFiles = files.map((f) => f.filename);
  const sinceISO = daysAgoISO(lookbackDays);

  const weights = {
    commitHistory: 1,
    codeowners: useCodeowners ? 4 : 0,
    latency: useLatency ? 1 : 0
  };

  // CODEOWNERS
  let codeownersRules = [];
  if (useCodeowners) {
    const ref = prHeadSha || undefined;
    let codeownersText = null;
    for (const p of CODEOWNERS_CANDIDATE_PATHS) {
      codeownersText = await tryFetchFileText(octokit, { owner, repo, path: p, ref });
      if (codeownersText) break;
    }
    codeownersRules = parseCodeowners(codeownersText);
    core.info(`CODEOWNERS rules loaded: ${codeownersRules.length}`);
  }

  // Commit history
  const fileAuthors = [];
  const filesToCheck = changedFiles.slice(0, maxFiles);
  for (const path of filesToCheck) {
    try {
      const authors = await topCommitAuthorsForPath(octokit, { owner, repo, path, sinceISO });
      if (authors.length) fileAuthors.push({ path, authors });
    } catch (e) {
      core.warning(`Failed commit lookup for ${path}: ${e?.message || e}`);
    }
  }

  // Review latency
  let latencyMap = new Map();
  if (useLatency) {
    try {
      latencyMap = await computeReviewerLatencyHours(octokit, {
        owner, repo, lookbackDays, maxClosedPRs: clamp(latencyPRs, 5, 50)
      });
      core.info(`Latency entries computed: ${latencyMap.size}`);
    } catch (e) {
      core.warning(`Latency computation failed (continuing): ${e?.message || e}`);
    }
  }

  // Exclusions
  const excluded = await fetchExcludedReviewers(octokit, {
    owner, repo, ref: prHeadSha, inputExcludes: excludeReviewersInput
  });
  if (excluded.size > 0) {
    core.info(`Excluded reviewers: ${[...excluded].join(", ")}`);
  }

  // Cross-repo expertise
  let crossRepoExpertise = new Map();
  if (crossRepoList.length > 0) {
    try {
      crossRepoExpertise = await fetchCrossRepoExpertise(octokit, {
        owner, repos: crossRepoList, filePaths: changedFiles, sinceISO
      });
      core.info(`Cross-repo expertise entries: ${crossRepoExpertise.size}`);
    } catch (e) {
      core.warning(`Cross-repo expertise failed (continuing): ${e?.message || e}`);
    }
  }

  // Timezone awareness
  let timezoneData = null;
  const preferredOffset = parseTimezoneOffset(preferTimezone);
  if (preferredOffset != null) {
    const avgHours = new Map();
    for (const { path: fp } of fileAuthors) {
      try {
        const resp = await octokit.rest.repos.listCommits({
          owner, repo, path: fp, since: sinceISO, per_page: 10
        });
        for (const c of resp.data) {
          const login = c.author?.login;
          const date = c.commit?.author?.date;
          if (!login || !date) continue;
          if (!avgHours.has(login)) avgHours.set(login, []);
          avgHours.get(login).push(new Date(date).getUTCHours());
        }
      } catch {
        // best effort
      }
    }
    const avgHourMap = new Map();
    for (const [login, hours] of avgHours) {
      const avg = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length);
      avgHourMap.set(login, avg);
    }
    timezoneData = { preferredOffset, avgHours: avgHourMap };
    core.info(`Timezone data computed for ${avgHourMap.size} authors`);
  }

  // Flaky reviewer detection
  let flakyReviewers = new Set();
  if (detectFlaky) {
    try {
      flakyReviewers = await detectFlakyReviewers(octokit, { owner, repo, lookbackDays });
      if (flakyReviewers.size > 0) {
        core.info(`Flaky reviewers detected: ${[...flakyReviewers].join(", ")}`);
      }
    } catch (e) {
      core.warning(`Flaky detection failed (continuing): ${e?.message || e}`);
    }
  }

  // Rank + pick
  let ranked = rankCandidates({
    fileAuthors, prAuthor, codeownersRules, changedFiles: filesToCheck,
    latencyMap, weights, crossRepoExpertise, timezoneData, requiredReviewers
  });

  ranked = ranked.filter((r) => !excluded.has(r.login.toLowerCase()));

  // Review load awareness
  if (penalizeLoad) {
    try {
      const loadCounts = await computeOpenReviewCounts(octokit, { owner, repo });
      for (const r of ranked) {
        const openReviews = loadCounts.get(r.login) || 0;
        r.openReviews = openReviews;
        r.score = Math.round(applyLoadPenalty(r.score, openReviews));
      }
      ranked.sort((a, b) => b.score - a.score);
    } catch (e) {
      core.warning(`Load computation failed (continuing): ${e?.message || e}`);
    }
  }

  // Apply flaky reviewer penalty
  if (flakyReviewers.size > 0) {
    for (const r of ranked) {
      if (flakyReviewers.has(r.login.toLowerCase())) {
        r.score = Math.round(r.score * 0.5);
        r.reasons = [...(r.reasons || []), "flaky reviewer"];
      }
    }
    ranked.sort((a, b) => b.score - a.score);
  }

  const suggestions = ranked.slice(0, maxReviewers);
  const confidence = computeConfidence({ ranked, changedFiles: filesToCheck, codeownersRules, fileAuthors });

  // Team-level coverage
  let teamCoverage = [];
  if (codeownersRules.length > 0) {
    const allTeams = new Set();
    for (const r of codeownersRules) {
      for (const t of (r.teams || [])) allTeams.add(t);
    }

    const suggestionLogins = new Set(suggestions.map((s) => s.login.toLowerCase()));
    for (const team of allTeams) {
      const teamMembers = new Set();
      for (const r of codeownersRules) {
        if ((r.teams || []).includes(team)) {
          for (const o of r.owners) teamMembers.add(o.toLowerCase());
        }
      }
      const count = [...teamMembers].filter((m) => suggestionLogins.has(m)).length;
      if (teamMembers.size > 0) {
        teamCoverage.push({ team, count, total: suggestions.length });
      }
    }
  }

  return { suggestions, confidence, teamCoverage, lookbackDays, maxFiles, fileCount: changedFiles.length, showBreakdown };
}

module.exports = {
  parseCommaSeparated,
  analyzeReviewers,
  formatReviewerSection
};
