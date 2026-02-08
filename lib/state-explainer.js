const core = require("@actions/core");
const { clampInt } = require("./utils");

// -------------------- Localization --------------------

const TRANSLATIONS = {
  en: {
    title: "PR State",
    lastActivity: "Last activity",
    draft: "Draft",
    mergeable: "Mergeable",
    likelyConflicts: "Likely conflicting files",
    checks: "Checks",
    noChecks: "no checks reported",
    failing: "failing",
    running: "running",
    totals: "totals",
    reviews: "Reviews",
    approvals: "approvals",
    changesRequested: "changes requested",
    requested: "requested",
    none: "none",
    blocking: "What's blocking this PR",
    nothingBlocking: "Nothing obvious. This PR looks ready to merge.",
    nextAction: "Next action expected from",
    notes: "heuristic-based; intended as a quick explanation, not a policy.",
    reviewLatency: "Review pending for",
    noReviewers: "No reviewers assigned — consider requesting a review.",
    unknown: "unknown (GitHub still calculating)",
    yes: "yes",
    no: "no"
  },
  de: {
    title: "PR-Status",
    lastActivity: "Letzte Aktivitat",
    draft: "Entwurf",
    mergeable: "Mergebar",
    likelyConflicts: "Wahrscheinlich konfliktbehaftete Dateien",
    checks: "Checks",
    noChecks: "keine Checks gemeldet",
    failing: "fehlgeschlagen",
    running: "laufend",
    totals: "gesamt",
    reviews: "Reviews",
    approvals: "Genehmigungen",
    changesRequested: "Anderungen angefordert",
    requested: "angefragt",
    none: "keine",
    blocking: "Was diese PR blockiert",
    nothingBlocking: "Nichts Offensichtliches. Diese PR sieht bereit zum Mergen aus.",
    nextAction: "Nachste Aktion erwartet von",
    notes: "heuristikbasiert; als schnelle Erklarung gedacht, nicht als Richtlinie.",
    reviewLatency: "Review ausstehend seit",
    noReviewers: "Keine Reviewer zugewiesen — erwagen Sie, ein Review anzufordern.",
    unknown: "unbekannt (GitHub berechnet noch)",
    yes: "ja",
    no: "nein"
  },
  es: {
    title: "Estado del PR",
    lastActivity: "Ultima actividad",
    draft: "Borrador",
    mergeable: "Fusionable",
    likelyConflicts: "Archivos probablemente en conflicto",
    checks: "Checks",
    noChecks: "sin checks reportados",
    failing: "fallando",
    running: "ejecutando",
    totals: "totales",
    reviews: "Revisiones",
    approvals: "aprobaciones",
    changesRequested: "cambios solicitados",
    requested: "solicitados",
    none: "ninguno",
    blocking: "Que bloquea este PR",
    nothingBlocking: "Nada obvio. Este PR parece listo para fusionar.",
    nextAction: "Proxima accion esperada de",
    notes: "basado en heuristicas; como explicacion rapida, no como politica.",
    reviewLatency: "Revision pendiente desde hace",
    noReviewers: "Sin revisores asignados — considere solicitar una revision.",
    unknown: "desconocido (GitHub aun calculando)",
    yes: "si",
    no: "no"
  }
};

function getTranslator(lang) {
  return TRANSLATIONS[lang] || TRANSLATIONS.en;
}

// -------------------- Helpers --------------------

function daysBetween(a, b) {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}

function fmtAgeDays(d) {
  if (d < 1) return "today";
  if (d < 2) return "1 day ago";
  return `${Math.floor(d)} days ago`;
}

function summarizeChecks(runs) {
  const counts = { success: 0, failure: 0, neutral: 0, cancelled: 0, skipped: 0, timed_out: 0, action_required: 0, stale: 0, in_progress: 0, queued: 0, unknown: 0 };
  for (const r of runs) {
    const c = r.conclusion || (r.status === "completed" ? "unknown" : r.status);
    if (counts[c] == null) counts.unknown++;
    else counts[c]++;
  }

  const failing = runs
    .filter((r) => (r.conclusion || "") === "failure")
    .slice(0, 5)
    .map((r) => r.name);

  const inProgress = runs
    .filter((r) => r.status && r.status !== "completed")
    .slice(0, 5)
    .map((r) => r.name);

  return { counts, failing, inProgress };
}

function classifyState({ pr, checksSummary, reviewsSummary, staleDays, ageDays }) {
  const blockers = [];
  const nextActors = new Set();
  const prAuthor = pr.user?.login;

  if (pr.draft) {
    blockers.push("PR is **Draft**.");
    if (prAuthor) nextActors.add(`@${prAuthor}`);
  }

  if (pr.mergeable === false) {
    blockers.push("PR has **merge conflicts**.");
    if (prAuthor) nextActors.add(`@${prAuthor}`);
  }

  if (checksSummary.failing.length) {
    blockers.push(`CI failing: ${checksSummary.failing.map((n) => `\`${n}\``).join(", ")}`);
    if (prAuthor) nextActors.add(`@${prAuthor}`);
  }

  if (checksSummary.inProgress.length) {
    blockers.push(`CI still running: ${checksSummary.inProgress.map((n) => `\`${n}\``).join(", ")}`);
  }

  if (reviewsSummary.requestedChanges > 0) {
    blockers.push(`Changes requested (${reviewsSummary.requestedChanges}).`);
    if (prAuthor) nextActors.add(`@${prAuthor}`);
  } else if (reviewsSummary.approvals === 0 && reviewsSummary.requestedReviewers.length) {
    blockers.push(`Awaiting review from: ${reviewsSummary.requestedReviewers.map((u) => `@${u}`).join(", ")}`);
    for (const u of reviewsSummary.requestedReviewers) {
      nextActors.add(u.startsWith("@") ? u : `@${u}`);
    }
  } else if (reviewsSummary.approvals === 0) {
    blockers.push("No approvals yet.");
  }

  if (ageDays >= staleDays) blockers.push(`No PR activity in **${Math.floor(ageDays)} days**.`);

  return { blockers, nextActors: [...nextActors] };
}

function computeReviewLatency(pr, now) {
  const createdAt = new Date(pr.created_at);
  const requestedReviewers = pr.requested_reviewers || [];
  const requestedTeams = pr.requested_teams || [];

  if (requestedReviewers.length === 0 && requestedTeams.length === 0) return null;

  const hoursSinceCreated = Math.round((now - createdAt) / 3600000);
  if (hoursSinceCreated < 1) return null;

  if (hoursSinceCreated < 24) return `${hoursSinceCreated}h`;
  const days = Math.round(hoursSinceCreated / 24);
  return `${days}d`;
}

function summarizeTeamReviews(pr) {
  const teams = (pr.requested_teams || []).map((t) => t.slug).filter(Boolean);
  if (teams.length === 0) return [];

  const teamLines = [];
  for (const team of teams) {
    teamLines.push(`\`${team}\` (team) — review pending`);
  }
  return teamLines;
}

// -------------------- Analyze a single PR --------------------

async function analyzeState(octokit, { owner, repo, pr, reviews, checkRuns, staleDays, staleOverridesRaw, showReviewLatency, language }) {
  const tr = getTranslator(language);

  const updatedAt = new Date(pr.updated_at);
  const now = new Date();
  const ageDays = daysBetween(now, updatedAt);

  const latestByUser = new Map();
  for (const r of reviews) {
    const login = r.user?.login;
    if (!login || !r.submitted_at) continue;
    const t = new Date(r.submitted_at);
    const prev = latestByUser.get(login);
    if (!prev || t > prev.t) latestByUser.set(login, { state: r.state, t });
  }

  let approvals = 0;
  let requestedChanges = 0;
  for (const v of latestByUser.values()) {
    if (v.state === "APPROVED") approvals++;
    if (v.state === "CHANGES_REQUESTED") requestedChanges++;
  }

  const requestedReviewers = [
    ...(pr.requested_reviewers || []).map((u) => u.login).filter(Boolean),
    ...(pr.requested_teams || []).map((t) => t.slug ? `${t.slug} (team)` : null).filter(Boolean)
  ];

  const reviewsSummary = { approvals, requestedChanges, requestedReviewers };
  const checksSummary = summarizeChecks(checkRuns);

  let effectiveStaleDays = staleDays;
  if (staleOverridesRaw) {
    try {
      const overrides = JSON.parse(staleOverridesRaw);
      const prLabels = (pr.labels || []).map((l) => l.name);
      for (const label of prLabels) {
        if (overrides[label] !== undefined) {
          effectiveStaleDays = clampInt(overrides[label], staleDays, 1, 365);
          break;
        }
      }
    } catch {
      core.warning("Could not parse stale_overrides as JSON; using default stale_days.");
    }
  }

  const { blockers, nextActors } = classifyState({
    pr,
    checksSummary,
    reviewsSummary,
    staleDays: effectiveStaleDays,
    ageDays
  });

  return {
    tr,
    pr,
    ageDays,
    checkRuns,
    checksSummary,
    approvals,
    requestedChanges,
    requestedReviewers,
    blockers,
    nextActors,
    showReviewLatency,
    now
  };
}

function formatStateSection(analysis) {
  const { tr, pr, ageDays, checkRuns, checksSummary, approvals, requestedChanges, requestedReviewers, blockers, nextActors, showReviewLatency, now } = analysis;
  const lines = [];

  lines.push(`#### ${tr.title}\n`);
  lines.push(`**${tr.lastActivity}:** ${fmtAgeDays(ageDays)} (${pr.updated_at})`);
  lines.push(`**${tr.draft}:** ${pr.draft ? tr.yes : tr.no}`);
  lines.push(`**${tr.mergeable}:** ${pr.mergeable === null ? tr.unknown : (pr.mergeable ? tr.yes : tr.no)}`);
  lines.push("");

  lines.push(`**${tr.checks}:**`);
  if (checkRuns.length === 0) {
    lines.push(`- ${tr.noChecks}`);
  } else {
    if (checksSummary.failing.length) lines.push(`- ${tr.failing}: ${checksSummary.failing.map((n) => `\`${n}\``).join(", ")}`);
    if (checksSummary.inProgress.length) lines.push(`- ${tr.running}: ${checksSummary.inProgress.map((n) => `\`${n}\``).join(", ")}`);
    const c = checksSummary.counts;
    lines.push(`- ${tr.totals}: ✅ ${c.success} | ❌ ${c.failure} | ⏳ ${c.in_progress + c.queued} | ⚪ ${c.skipped + c.neutral}`);
  }
  lines.push("");

  lines.push(`**${tr.reviews}:**`);
  lines.push(`- ${tr.approvals}: ${approvals}`);
  lines.push(`- ${tr.changesRequested}: ${requestedChanges}`);
  if (requestedReviewers.length) {
    lines.push(`- ${tr.requested}: ${requestedReviewers.map((u) => u.startsWith("@") ? u : `@${u}`).join(", ")}`);
  } else {
    lines.push(`- ${tr.requested}: ${tr.none}`);
  }

  if (showReviewLatency) {
    const latency = computeReviewLatency(pr, now);
    if (latency) {
      lines.push(`- ${tr.reviewLatency}: **${latency}**`);
    }
  }

  const teamLines = summarizeTeamReviews(pr);
  for (const tl of teamLines) {
    lines.push(`- ${tl}`);
  }

  if (approvals === 0 && requestedReviewers.length === 0 && !pr.draft) {
    lines.push(`- ${tr.noReviewers}`);
  }
  lines.push("");

  lines.push(`**${tr.blocking}:**`);
  if (blockers.length) {
    for (const b of blockers) lines.push(`- ${b}`);
  } else {
    lines.push(`- ${tr.nothingBlocking}`);
  }
  lines.push("");

  if (nextActors.length > 0) {
    lines.push(`**${tr.nextAction}:** ${nextActors.join(", ")}`);
    lines.push("");
  }

  lines.push(`_${tr.notes}_`);

  return lines.join("\n");
}

// -------------------- Stale sweep --------------------

async function staleSweep(octokit, { owner, repo, staleDays, maxChecks, staleOverridesRaw, dryRun, showReviewLatency, language, maxPRs, marker }) {
  const { upsertComment } = require("./utils");

  const prs = await octokit.rest.pulls.list({
    owner, repo, state: "open", sort: "updated", direction: "asc", per_page: maxPRs
  });

  const now = new Date();
  let processed = 0;

  for (const prSummary of prs.data) {
    const updatedAt = new Date(prSummary.updated_at);
    const ageDays = daysBetween(now, updatedAt);
    if (ageDays < staleDays) continue;

    try {
      const prResp = await octokit.rest.pulls.get({ owner, repo, pull_number: prSummary.number });
      const pr = prResp.data;

      const reviewsResp = await octokit.rest.pulls.listReviews({ owner, repo, pull_number: pr.number, per_page: 100 });
      const checksResp = await octokit.rest.checks.listForRef({ owner, repo, ref: pr.head.sha, per_page: maxChecks });

      const analysis = await analyzeState(octokit, {
        owner, repo, pr, reviews: reviewsResp.data, checkRuns: checksResp.data.check_runs || [],
        staleDays, staleOverridesRaw, showReviewLatency, language
      });

      const body = `### PR Advisor\n${marker}\n\n---\n` + formatStateSection(analysis);

      if (dryRun) {
        core.info(`Dry-run PR #${pr.number}:\n${body}`);
      } else {
        const res = await upsertComment(octokit, { owner, repo, issue_number: pr.number, body, marker });
        core.info(`PR #${pr.number}: ${res.updated ? "updated" : "created"} comment: ${res.url}`);
      }
      processed++;
    } catch (err) {
      core.warning(`Failed to analyze PR #${prSummary.number}: ${err?.message || err}`);
    }
  }

  core.info(`Stale sweep complete: processed ${processed} stale PR(s) out of ${prs.data.length} open.`);
}

module.exports = {
  daysBetween,
  analyzeState,
  formatStateSection,
  staleSweep
};
