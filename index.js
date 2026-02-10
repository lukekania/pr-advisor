import * as core from "@actions/core";
import * as github from "@actions/github";

import { toBool, clampInt, upsertComment, deleteCommentByMarker, listAllPRFiles, fmt } from "./lib/utils.js";
import { DEFAULT_IGNORE, parseIgnorePatterns, filterIgnoredFiles, analyzeSize, formatSizeSection, applySizeLabel } from "./lib/size-analyzer.js";
import { daysBetween, analyzeState, formatStateSection, staleSweep } from "./lib/state-explainer.js";
import { parseCommaSeparated, analyzeReviewers, formatReviewerSection } from "./lib/reviewer-suggester.js";

const MARKER = "<!-- pr-advisor:v0 -->";

const OLD_MARKERS = [
  "<!-- analyze-pr-size:v0 -->",
  "<!-- pr-state-explainer:v0 -->",
  "<!-- reviewer-suggester:v0 -->"
];

async function cleanupOldComments(octokit, { owner, repo, issue_number }) {
  for (const marker of OLD_MARKERS) {
    try {
      await deleteCommentByMarker(octokit, { owner, repo, issue_number, marker });
    } catch {
      // best effort
    }
  }
}

async function run() {
  try {
    const token = core.getInput("github_token", { required: true });
    const dryRun = toBool(core.getInput("dry_run"), false);
    const stepSummary = toBool(core.getInput("step_summary"), false);

    // Section toggles
    const enableSize = toBool(core.getInput("enable_size"), true);
    const enableState = toBool(core.getInput("enable_state"), true);
    const enableReviewer = toBool(core.getInput("enable_reviewer"), true);

    // Size inputs
    const maxFiles = clampInt(core.getInput("max_files"), 500, 1, 5000);
    const addLabel = toBool(core.getInput("add_label"), false);
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

    // State inputs
    const staleDays = clampInt(core.getInput("stale_days"), 3, 1, 365);
    const commentOnlyWhenStale = toBool(core.getInput("comment_only_when_stale"), false);
    const maxChecks = clampInt(core.getInput("max_checks"), 50, 10, 200);
    const staleOverridesRaw = core.getInput("stale_overrides") || "";
    const showReviewLatency = toBool(core.getInput("review_latency"), false);
    const language = (core.getInput("language") || "en").trim().toLowerCase();
    const sweepStale = toBool(core.getInput("sweep_stale"), false);
    const maxPRs = clampInt(core.getInput("max_prs"), 50, 1, 200);

    // Reviewer inputs
    const maxReviewers = clampInt(core.getInput("max_reviewers"), 3, 1, 20);
    const lookbackDays = clampInt(core.getInput("lookback_days"), 90, 1, 365);
    const reviewerMaxFiles = clampInt(core.getInput("reviewer_max_files"), 50, 1, 200);
    const useCodeowners = toBool(core.getInput("use_codeowners"), true);
    const useLatency = toBool(core.getInput("use_latency"), true);
    const latencyPRs = clampInt(core.getInput("latency_prs"), 20, 5, 50);
    const penalizeLoad = toBool(core.getInput("penalize_load"), true);
    const excludeReviewersInput = parseCommaSeparated(core.getInput("exclude_reviewers"));
    const crossRepoList = parseCommaSeparated(core.getInput("cross_repo_list"));
    const requiredReviewers = parseCommaSeparated(core.getInput("required_reviewers"));
    const preferTimezone = (core.getInput("prefer_timezone") || "").trim();
    const showBreakdown = toBool(core.getInput("show_breakdown"), false);
    const detectFlaky = toBool(core.getInput("detect_flaky"), false);

    const ctx = github.context;
    const octokit = github.getOctokit(token);
    const { owner, repo } = ctx.repo;

    // Stale sweep mode: only state section runs, iterates all open PRs
    if (sweepStale || ctx.eventName === "schedule") {
      await staleSweep(octokit, {
        owner, repo, staleDays, maxChecks, staleOverridesRaw,
        dryRun, showReviewLatency, language, maxPRs, marker: MARKER
      });
      return;
    }

    if (ctx.eventName !== "pull_request" || !ctx.payload.pull_request) {
      core.info("Not a pull_request event; skipping.");
      return;
    }

    const prNumber = ctx.payload.pull_request.number;
    const prAuthor = ctx.payload.pull_request.user?.login;
    const prHeadSha = ctx.payload.pull_request.head?.sha;

    // Check stale-only mode
    if (commentOnlyWhenStale) {
      const updatedAt = new Date(ctx.payload.pull_request.updated_at);
      const ageDays = daysBetween(new Date(), updatedAt);
      if (ageDays < staleDays) {
        core.info(`PR not stale (${ageDays.toFixed(2)} days < ${staleDays}); skipping comment.`);
        return;
      }
    }

    // ---- Shared API calls (fetch once, pass to modules) ----
    const prResp = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const pr = prResp.data;

    const allFiles = await listAllPRFiles(octokit, {
      owner, repo, pull_number: prNumber, maxFiles
    });

    const reviewsResp = await octokit.rest.pulls.listReviews({
      owner, repo, pull_number: prNumber, per_page: 100
    });

    let checkRuns = [];
    try {
      const checksResp = await octokit.rest.checks.listForRef({
        owner, repo, ref: pr.head.sha, per_page: maxChecks
      });
      checkRuns = checksResp.data.check_runs || [];
    } catch {
      core.warning("Could not fetch check runs (needs checks:read permission); skipping checks info.");
    }

    // ---- Build sections ----
    const sections = [];

    if (enableSize) {
      const { counted: files, ignoredCount } = filterIgnoredFiles(allFiles, ignorePatterns);
      const thresholds = { xsLines, sLines, mLines, lLines, xsFiles, sFiles, mFiles, lFiles };
      const sizeResult = analyzeSize({ files, thresholds });

      sections.push(formatSizeSection({
        ...sizeResult,
        ignoredCount,
        files
      }));

      core.setOutput("size", sizeResult.size);
      core.setOutput("total_lines", sizeResult.totalChanged);
      core.setOutput("file_count", sizeResult.fileCount);

      const prCreatedAt = ctx.payload.pull_request.created_at;
      if (prCreatedAt) {
        const ageHours = Math.round((Date.now() - new Date(prCreatedAt).getTime()) / 3600000);
        core.setOutput("pr_age_hours", ageHours);
      }

      if (addLabel) {
        await applySizeLabel(octokit, { owner, repo, prNumber, size: sizeResult.size });
        core.info(`Applied label: size:${sizeResult.size}`);
      }
    }

    if (enableState) {
      const analysis = await analyzeState(octokit, {
        owner, repo, pr,
        reviews: reviewsResp.data,
        checkRuns,
        staleDays, staleOverridesRaw, showReviewLatency, language
      });

      sections.push(formatStateSection(analysis));
    }

    if (enableReviewer) {
      const reviewerResult = await analyzeReviewers(octokit, {
        owner, repo, prNumber, prAuthor, prHeadSha,
        files: allFiles, reviews: reviewsResp.data,
        config: {
          maxReviewers, lookbackDays, maxFiles: reviewerMaxFiles,
          useCodeowners, useLatency, latencyPRs,
          penalizeLoad, excludeReviewersInput, crossRepoList, requiredReviewers,
          preferTimezone, showBreakdown, detectFlaky
        }
      });

      sections.push(formatReviewerSection(reviewerResult));

      if (dryRun) {
        core.setOutput("suggestions_json", JSON.stringify(reviewerResult.suggestions));
      }
    }

    if (sections.length === 0) {
      core.info("All sections disabled; nothing to do.");
      return;
    }

    const body = `### PR Advisor\n${MARKER}\n\n---\n` + sections.join("\n---\n");

    if (dryRun) {
      core.info("Dry-run mode: comment body below (not posted):");
      core.info(body);
      return;
    }

    // Clean up old individual action comments on first run
    await cleanupOldComments(octokit, { owner, repo, issue_number: prNumber });

    const res = await upsertComment(octokit, { owner, repo, issue_number: prNumber, body, marker: MARKER });
    core.info(res.updated ? "Updated PR Advisor comment." : "Created PR Advisor comment.");
    core.info(`Comment: ${res.url}`);

    if (stepSummary) {
      await core.summary.addRaw(body).write();
      core.info("Wrote step summary.");
    }
  } catch (err) {
    core.setFailed(err?.message || String(err));
  }
}

run();
