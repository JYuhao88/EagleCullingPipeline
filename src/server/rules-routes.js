import { replaceFile } from '../core/atomic-file.js';
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { json, parseBody, CORS_HEADERS } from "./http.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const severities = new Set(["gate", "penalty", "hint"]);
const checkers = new Set(["measure", "teacher", "measure+teacher"]);
const editable = new Set(["statement", "severity", "check", "exceptions"]);
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
async function optionalJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await replaceFile(temporary, file);
}
export function validateRulePatch(patch) {
  assert(patch && typeof patch === "object" && !Array.isArray(patch), "patch must be an object");
  assert(
    Object.keys(patch).every((key) => editable.has(key)),
    "unsupported patch field",
  );
  if ("statement" in patch)
    assert(
      typeof patch.statement === "string" && patch.statement.trim() && patch.statement.length <= 1000,
      "invalid statement",
    );
  if ("severity" in patch) assert(severities.has(patch.severity), "invalid severity");
  if ("check" in patch) {
    assert(patch.check && typeof patch.check === "object" && !Array.isArray(patch.check), "invalid check");
    assert(
      Object.keys(patch.check).length === 1 && checkers.has(patch.check.by),
      "only check.by is editable",
    );
  }
  if ("exceptions" in patch)
    assert(
      Array.isArray(patch.exceptions) &&
        patch.exceptions.length <= 30 &&
        patch.exceptions.every((item) => typeof item === "string" && item.length <= 1000),
      "invalid exceptions",
    );
  return patch;
}
const courseLocatorKey = (locator = {}) =>
  JSON.stringify([locator.source, locator.course, locator.episode, locator.start, locator.end, locator.page, locator.episodeId]);
const evidenceKey = (item) => item.courseSlug
  ? JSON.stringify(["course", item.courseSlug, courseLocatorKey(item.locator), item.kind, item.paraphrase])
  : item.paperSlug
  ? JSON.stringify(["paper", item.paperSlug, item.locator, item.kind, item.paraphrase])
  : item.bookSlug
  ? JSON.stringify(["book", item.bookSlug, item.locator, item.kind, item.paraphrase])
  : JSON.stringify(["video", item.bvid, item.segment, item.kind || item.polarity, item.text || item.paraphrase]);
const uniqueEvidence = (items) => {
  const unique = new Map();
  for (const item of items) {
    const key = evidenceKey(item);
    const previous = unique.get(key);
    if (item.paperSlug && previous) {
      // A candidate may repeat the primary citation of an aggregated paper claim.
      // Keep every supporting locator rather than replacing the aggregate with it.
      const supports = [...new Map([previous, item].flatMap((entry) =>
        entry.supports?.length ? entry.supports : [{
          paperSlug: entry.paperSlug, locator: entry.locator, paper: entry.paper,
        }],
      ).map((support) => [JSON.stringify([support.paperSlug, support.locator]), support])).values()];
      unique.set(key, {
        ...previous, ...item, supports,
        supportCount: Math.max(previous.supportCount || 1, item.supportCount || 1,
          new Set(supports.map((support) => support.paperSlug)).size),
      });
    } else if (item.courseSlug && previous) {
      const supports = [...new Map([previous, item].flatMap((entry) =>
        [{ locator: entry.locator }, ...(entry.supports || [])],
      ).map((support) => [courseLocatorKey(support.locator), support])).values()];
      unique.set(key, { ...previous, ...item,
        supports,
        supportCount: Math.max(previous.supportCount || 1, item.supportCount || 1,
          new Set(supports.map((support) =>
            JSON.stringify([support.locator.source, support.locator.course, support.locator.episode, support.locator.episodeId]),
          )).size),
      });
    } else unique.set(key, item);
  }
  return [...unique.values()];
};
export function applyRuleDecisions(seed, candidates, decisions) {
  const rules = new Map(
    [...seed.rules.map((rule) => ({ ...rule, status: "existing" })), ...candidates.rules].map((rule) => [
      rule.id,
      structuredClone(rule),
    ]),
  );
  for (const decision of decisions) {
    const rule = rules.get(decision.ruleId);
    if (!rule) continue;
    if (decision.action === "approve" || decision.action === "modify") {
      const patch = decision.patch || {};
      Object.assign(rule, patch, { check: { ...rule.check, ...patch.check }, status: "approved" });
    } else if (decision.action === "delete") rule.status = "deleted";
    else if (decision.action === "merge") {
      const target = rules.get(decision.targetId);
      if (!target) continue;
      target.sources = [...new Set([...(target.sources || []), ...(rule.sources || [])])];
      target.evidence = uniqueEvidence([...(target.evidence || []), ...(rule.evidence || [])]);
      target.bookEvidence = uniqueEvidence([...(target.bookEvidence || []), ...(rule.bookEvidence || [])]);
      target.paperEvidence = uniqueEvidence([...(target.paperEvidence || []), ...(rule.paperEvidence || [])]);
      target.courseEvidence = uniqueEvidence([...(target.courseEvidence || []), ...(rule.courseEvidence || [])]);
      const videoEvidence = target.evidence.filter((item) => item.bvid && !item.bookSlug && !item.paperSlug && !item.courseSlug);
      const segmentTiers = new Map(
        videoEvidence.map((item) => [`${item.bvid}:${item.segment}`, item.tier]),
      );
      target.frequency = {
        videos: new Set(videoEvidence.map((item) => item.bvid)).size,
        segments: segmentTiers.size,
        positive: new Set(
          videoEvidence
            .filter((item) => ["praise", "positive"].includes(item.kind || item.polarity))
            .map((item) => `${item.bvid}:${item.segment}`),
        ).size,
        negative: new Set(
          videoEvidence
            .filter((item) => ["issue", "negative"].includes(item.kind || item.polarity))
            .map((item) => `${item.bvid}:${item.segment}`),
        ).size,
        tierHigh: [...segmentTiers.values()].filter((tier) => ["夯", "顶尖", "人上人"].includes(tier)).length,
        tierLow: [...segmentTiers.values()].filter((tier) => ["NPC", "拉"].includes(tier)).length,
      };
      rule.status = "merged";
      rule.mergedInto = target.id;
    }
  }
  return [...rules.values()];
}
export function createRulesRouter({ projectRoot = root } = {}) {
  const rulesDir = path.join(projectRoot, "src/rules");
  const decisionsPath = path.join(rulesDir, "review/decisions.json");
  const draftPath = path.join(rulesDir, "review/portrait.v0.2.draft.json");
  let pending = Promise.resolve();
  const serialized = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  async function data() {
    const seed = await optionalJson(path.join(rulesDir, "portrait.json"), { rules: [] });
    const candidates = await optionalJson(path.join(rulesDir, "candidates/portrait-v0.2-candidates.json"), {
      rules: [],
    });
    const bookCandidates = await optionalJson(path.join(rulesDir, "candidates/book-candidates.json"), {
      contractVersion: 1, books: [], rules: [],
    });
    const bookEvidence = await optionalJson(path.join(rulesDir, "candidates/book-evidence.json"), {
      contractVersion: 1, books: [], evidence: [],
    });
    assert(Array.isArray(bookCandidates.rules) && Array.isArray(bookEvidence.evidence), "invalid book data");
    const books = new Map([...(bookCandidates.books || []), ...(bookEvidence.books || [])].map((book) => [book.slug, book]));
    const attachBooks = (rule) => ({
      ...rule,
      bookEvidence: uniqueEvidence([
        ...(rule.bookEvidence || []),
        ...(rule.evidence || []).filter((item) => item.bookSlug),
        ...bookEvidence.evidence.filter((item) => item.ruleId === rule.id),
      ]).map((item) => ({ ...item, book: books.get(item.bookSlug) })),
    });
    const paperCandidates = await optionalJson(path.join(rulesDir, "candidates/paper-candidates.json"), {
      contractVersion: 1, papers: [], rules: [],
    });
    const paperEvidence = await optionalJson(path.join(rulesDir, "candidates/paper-evidence.json"), {
      contractVersion: 1, papers: [], evidence: [],
    });
    assert(Array.isArray(paperCandidates.rules) && Array.isArray(paperEvidence.evidence), "invalid paper data");
    const papers = new Map([...(paperCandidates.papers || []), ...(paperEvidence.papers || [])].map((paper) => [paper.slug, paper]));
    const courseCandidates = await optionalJson(path.join(rulesDir, "candidates/course-candidates.json"), {
      contractVersion: 1, rules: [],
    });
    const courseEvidence = await optionalJson(path.join(rulesDir, "candidates/course-evidence.json"), {
      contractVersion: 1, courses: [], evidence: [],
    });
    assert(Array.isArray(courseCandidates.rules) && Array.isArray(courseEvidence.evidence) &&
      Array.isArray(courseEvidence.courses), "invalid course data");
    const courses = new Map(courseEvidence.courses.map((course) => [course.slug, course]));
    const attachReferences = (rule) => ({
      ...attachBooks(rule),
      courseEvidence: uniqueEvidence([
        ...(rule.courseEvidence || []),
        ...(rule.evidence || []).filter((item) => item.courseSlug),
        ...courseEvidence.evidence.filter((item) => item.ruleId === rule.id),
      ]).map((item) => ({ ...item, course: courses.get(item.courseSlug) })),
      paperEvidence: uniqueEvidence([
        ...(rule.paperEvidence || []),
        ...(rule.evidence || []).filter((item) => item.paperSlug),
        ...paperEvidence.evidence.filter((item) => item.ruleId === rule.id),
      ]).map((item) => ({ ...item, paper: papers.get(item.paperSlug),
        supports: (item.supports || []).map((support) => ({ ...support, paper: papers.get(support.paperSlug) })),
      })),
    });
    const wulinCandidates = await optionalJson(path.join(rulesDir, "candidates/landscape-street-v0.2-candidates.json"), { rules: [] });
    const wulinEvidence = await optionalJson(path.join(rulesDir, "candidates/wulin-evidence.json"), { rules: [] });
    assert(Array.isArray(wulinCandidates.rules) && Array.isArray(wulinEvidence.rules), "invalid wulin data");
    const attachWulin = (rule) => {
      const extra = wulinEvidence.rules.find((item) => item.id === rule.id);
      if (!extra) return rule;
      const evidence = (extra.evidence || []).map((item) => ({ ...item, source: "wulin-critiques" }));
      return { ...rule, wulinEvidence: evidence, wulinFrequency: extra.frequency,
        sources: [...new Set([...(rule.sources || []), "wulin-critiques"])],
        evidence: uniqueEvidence([...(rule.evidence || []), ...evidence]),
        representatives: uniqueEvidence([...(extra.representatives || evidence),
          ...(rule.representatives || [])]).slice(0, 4),
        frequency: rule.frequency || extra.frequency,
      };
    };
    const decisions = await optionalJson(decisionsPath, []);
    const existingEvidence = await optionalJson(path.join(rulesDir, "candidates/existing-evidence.json"), {});
    for (const rule of seed.rules) {
      const extra = existingEvidence.rules?.find((item) => item.id === rule.id) || existingEvidence[rule.id];
      if (extra) Object.assign(rule, Array.isArray(extra) ? { evidence: extra } : extra);
    }
    const referenceRules = [];
    for (const file of ["general.json", "landscape.json", "street.json", "candidates/xhs-candidates.json"]) {
      const library = await optionalJson(path.join(rulesDir, file), { rules: [] });
      for (const rule of library.rules) {
        const extra = existingEvidence.rules?.find((item) => item.id === rule.id);
        const withBooks = attachReferences(attachWulin({ ...rule, ...extra, library: rule.library || library.library }));
        if (extra || withBooks.wulinEvidence?.length || withBooks.bookEvidence.length || withBooks.paperEvidence.length ||
          withBooks.courseEvidence.length) {
          referenceRules.push({ ...withBooks, status: "reference" });
        }
      }
    }
    assert(
      Array.isArray(seed.rules) && Array.isArray(candidates.rules) && Array.isArray(decisions),
      "invalid rule data",
    );
    const reviewCandidates = {
      ...candidates,
      rules: [...candidates.rules, ...bookCandidates.rules, ...paperCandidates.rules, ...courseCandidates.rules,
        ...wulinCandidates.rules].map((rule) => attachReferences(attachWulin(rule))),
    };
    const reviewSeed = { ...seed, rules: seed.rules.map((rule) => attachReferences(attachWulin(rule))) };
    return {
      seed, candidates, decisions, referenceRules, bookCandidates, bookEvidence,
      paperCandidates, paperEvidence, courseCandidates, courseEvidence, wulinCandidates, wulinEvidence,
      rules: applyRuleDecisions(reviewSeed, reviewCandidates, decisions),
    };
  }
  return async function rulesRoute(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/rules/")) return false;
    try {
      if (
        req.method === "GET" &&
        [
          "/rules/review",
          "/rules/review.js",
          "/rules/review.css",
          "/rules/rules-review.js",
          "/rules/rules-review.css",
        ].includes(url.pathname)
      ) {
        const extension = url.pathname === "/rules/review" ? "html" : url.pathname.split(".").pop();
        const content = await readFile(path.join(projectRoot, `src/plugin/rules-review.${extension}`));
        res.writeHead(200, {
          "content-type": {
            html: "text/html; charset=utf-8",
            js: "text/javascript; charset=utf-8",
            css: "text/css; charset=utf-8",
          }[extension],
          ...CORS_HEADERS,
        });
        res.end(content);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/rules/data") {
        const state = await data();
        const consolidatedReview = await optionalJson(path.join(rulesDir, "candidates/consolidated-review.json"), null);
        const suggestions = new Map();
        for (const entry of [...(consolidatedReview?.entries || []), ...(consolidatedReview?.formalRules || [])]) {
          for (const id of [entry.id, ...(entry.aliases || [])]) {
            suggestions.set(id, {
              isSuggestion: true, mainId: entry.id, aliases: entry.aliases || [],
              isAlias: id !== entry.id, mergeReason: entry.mergeReason,
              recommendation: id === entry.id ? entry.recommendation : "merge",
              rank: entry.priority?.rank, score: entry.priority?.score,
            });
          }
        }
        const attachSuggestion = (rule) => suggestions.has(rule.id)
          ? { ...rule, reviewSuggestion: suggestions.get(rule.id) } : rule;
        return json(res, 200, {
          rules: state.rules.map(attachSuggestion),
          decisions: state.decisions,
          version: state.seed.version,
          existingIds: state.seed.rules.map((rule) => rule.id),
          referenceRules: state.referenceRules.map(attachSuggestion),
          consolidatedReview,
          bookCandidates: state.bookCandidates,
          bookEvidence: state.bookEvidence,
          paperCandidates: state.paperCandidates,
          paperEvidence: state.paperEvidence,
          courseCandidates: state.courseCandidates,
          courseEvidence: state.courseEvidence,
          wulinCandidates: state.wulinCandidates,
          wulinEvidence: state.wulinEvidence,
          synthesis: state.candidates.synthesis,
          extractionStatus: state.candidates.extractionStatus,
        });
      }
      if (req.method === "GET" && url.pathname.startsWith("/rules/frames/")) {
        const name = decodeURIComponent(url.pathname.slice("/rules/frames/".length));
        assert(/^(?:BV[A-Za-z0-9]+\/)?[A-Za-z0-9_-]+\.jpg$/.test(name), "invalid frame name");
        try {
          const frameRoot = await realpath(path.join(projectRoot, "data/rules-review/frames"));
          const framePath = await realpath(path.join(frameRoot, name));
          assert(framePath.startsWith(`${frameRoot}${path.sep}`), "frame outside cache");
          const image = await readFile(framePath);
          res.writeHead(200, { "content-type": "image/jpeg", ...CORS_HEADERS });
          res.end(image);
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return json(res, 404, { error: "frame not cached" });
          throw error;
        }
      }
      if (req.method === "POST" && url.pathname === "/rules/decisions") {
        const body = await parseBody(req);
        return await serialized(async () => {
          assert(body && typeof body === "object" && !Array.isArray(body), "decision must be an object");
          assert(
            Object.keys(body).every((key) => ["ruleId", "action", "patch", "targetId"].includes(key)),
            "unsupported decision field",
          );
          const state = await data();
          const rule = state.rules.find((item) => item.id === body.ruleId);
          assert(rule, "unknown rule");
          assert(["approve", "modify", "merge", "delete"].includes(body.action), "invalid action");
          assert(!["merged", "deleted"].includes(rule.status), "rule already removed");
          if (body.patch !== undefined) {
            assert(["approve", "modify"].includes(body.action), "patch not allowed");
            validateRulePatch(body.patch);
          }
          if (body.action === "modify")
            assert(body.patch && Object.keys(body.patch).length, "modify requires patch");
          if (body.action === "merge") {
            assert(!rule.library || rule.library === "portrait", "only portrait candidates can merge into portrait rules");
            assert(!state.seed.rules.some((item) => item.id === rule.id), "only candidates can be merged");
            assert(
              body.targetId !== body.ruleId &&
                state.seed.rules.some((item) => item.id === body.targetId) &&
                !["deleted", "merged"].includes(
                  state.rules.find((item) => item.id === body.targetId)?.status,
                ),
              "merge target must be an active existing rule",
            );
          } else assert(body.targetId === undefined, "targetId only allowed for merge");
          const decision = { ...body, timestamp: new Date().toISOString() };
          await saveJson(decisionsPath, [...state.decisions, decision]);
          return json(res, 200, { decision });
        });
      }
      if (req.method === "POST" && url.pathname === "/rules/export") {
        return await serialized(async () => {
          const state = await data();
          const draft = {
            ...state.seed,
            version: "0.2.0",
            rules: state.rules
              .filter((rule) => ["existing", "approved"].includes(rule.status) && (!rule.library || rule.library === "portrait"))
              .map(({ status, mergedInto, ...rule }) => rule),
          };
          await saveJson(draftPath, draft);
          const bookDrafts = {};
          const paperDrafts = {};
          const courseDrafts = {};
          const wulinDrafts = {};
          for (const rule of state.rules.filter((item) => item.status === "approved" && item.library && item.library !== "portrait")) {
            const { status, mergedInto, ...approved } = rule;
            const drafts = rule.source?.startsWith("course:") ? courseDrafts : rule.source === "wulin-critiques" ? wulinDrafts
              : rule.source === "paper" ? paperDrafts : bookDrafts;
            (drafts[rule.library] ||= { contractVersion: 1, library: rule.library, rules: [] }).rules.push(approved);
          }
          return json(res, 200, { draft, bookDrafts, paperDrafts, courseDrafts, wulinDrafts,
            path: "src/rules/review/portrait.v0.2.draft.json" });
        });
      }
      return json(res, 404, { error: "rules route not found" });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  };
}
