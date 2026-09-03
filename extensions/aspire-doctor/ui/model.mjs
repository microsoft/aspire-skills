// Pure normalization helpers shared by the provider, renderer, and tests.
const SUMMARY_KEYS = ["passed", "warnings", "failed"];

export function normalizeStatus(status) {
    const text = String(status ?? "").trim().toLowerCase();
    return text === "passed" || text === "ok" || text === "success" ? "pass"
        : text === "warn" ? "warning"
        : text === "failed" || text === "error" ? "fail"
        : text;
}

export function deriveSummary(checks) {
    const summary = { passed: 0, warnings: 0, failed: 0 };
    for (const check of checks) {
        if (check.status === "pass") {
            summary.passed++;
        } else if (check.status === "warning") {
            summary.warnings++;
        } else if (check.status === "fail") {
            summary.failed++;
        }
    }
    return summary;
}

function normalizeSuppliedSummary(summary) {
    if (!summary || typeof summary !== "object") {
        return null;
    }

    const normalized = {};
    for (const key of SUMMARY_KEYS) {
        const value = Number(summary[key]);
        if (!Number.isFinite(value) || value < 0) {
            return null;
        }
        normalized[key] = value;
    }
    return normalized;
}

function summariesMatch(left, right) {
    return SUMMARY_KEYS.every((key) => left[key] === right[key]);
}

export function normalizeDoctorData(raw) {
    const hasChecksArray = Array.isArray(raw?.checks);
    const rawChecks = hasChecksArray ? raw.checks : [];
    const checks = rawChecks
        .filter((check) => check && typeof check === "object")
        .map((check, index) => ({
            ...check,
            __index: index,
            category: String(check.category ?? "other").trim() || "other",
            name: String(check.name ?? "check"),
            status: normalizeStatus(check.status),
            message: check.message == null ? "" : String(check.message),
            fix: check.fix == null ? "" : String(check.fix),
            metadata: check.metadata && typeof check.metadata === "object" ? check.metadata : null,
        }));

    const summary = deriveSummary(checks);
    const suppliedSummary = normalizeSuppliedSummary(raw?.summary);
    const notices = [];

    if (!hasChecksArray) {
        notices.push({
            title: "Doctor output format changed",
            message: "Aspire Doctor returned JSON without a checks array. The canvas is showing the parts it can still understand.",
        });
    }
    if (raw?.summary != null && (!suppliedSummary || !summariesMatch(suppliedSummary, summary))) {
        notices.push({
            title: "Doctor summary adjusted",
            message: "The reported summary did not match the checks. Counts were recalculated from the visible results.",
        });
    }

    return {
        ...raw,
        checks,
        summary,
        installations: Array.isArray(raw?.installations) ? raw.installations : [],
        notices,
    };
}

export function summaryStatusText(summary, checkCount) {
    if (checkCount === 0) {
        return "No checks reported";
    }
    if (summary.failed > 0) {
        return `${summary.failed} failed · ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}`;
    }
    if (summary.warnings > 0) {
        return `All required checks passed · ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}`;
    }
    return "Everything looks good";
}

export function getResultRevision(result) {
    const revision = Number(result?.revision);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export function shouldApplyResult(latestRevision, result) {
    if (result?.superseded) {
        return false;
    }
    const revision = getResultRevision(result);
    return revision == null || revision > latestRevision;
}
