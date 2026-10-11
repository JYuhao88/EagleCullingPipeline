const rate = (a, b) => (b ? a / b : null);
export const stemOf = (name) =>
  String(name ?? "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
export const starTruth = (n) => (item) => Number(item.star ?? 0) >= n;
export const tagTruth = (tag) => (item) => (item.tags ?? []).includes(tag);
export const folderTruth = (folder) => (item) =>
  (item.folders ?? []).includes(folder);
export const anyTruth =
  (...predicates) =>
  (item) =>
    predicates.some((fn) => fn(item));
export const allTruth =
  (...predicates) =>
  (item) =>
    predicates.every((fn) => fn(item));
export function parseTruth(spec) {
  const star = /^star>=(\d+)$/.exec(spec);
  if (star) return starTruth(Number(star[1]));
  for (const [prefix, fn] of [
    ["tag=", tagTruth],
    ["folder=", folderTruth],
  ]) {
    if (spec.startsWith(prefix) && spec.length > prefix.length)
      return fn(spec.slice(prefix.length));
  }
  throw new Error(`无效真值规则：${spec}`);
}
export function seededRandom(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function auc(positives, negatives) {
  if (!positives.length || !negatives.length) return null;
  const rows = [
    ...positives.map((score) => ({ score, pick: true })),
    ...negatives.map((score) => ({ score, pick: false })),
  ].sort((a, b) => a.score - b.score);
  let wins = 0,
    below = 0;
  for (let i = 0; i < rows.length;) {
    let j = i,
      p = 0,
      n = 0;
    while (j < rows.length && rows[j].score === rows[i].score) {
      rows[j++].pick ? p++ : n++;
    }
    wins += p * (below + n / 2);
    below += n;
    i = j;
  }
  return wins / (positives.length * negatives.length);
}
// All input is an in-memory run snapshot; paired items are tested without I/O.
function prepare({ data, fixture, run }, truth, index) {
  if (!truth.length && !Array.isArray(fixture?.selectedStems))
    throw new Error("需要带 selectedStems 的已确认真值 fixture 或显式 --truth；直出样本清单不是真值");
  const items = new Map(data.items.map((item) => [item.id, item]));
  const results = new Map((data.results ?? []).map((r) => [r.unitId, r]));
  const scope = fixture?.allStems && new Set(fixture.allStems.map(stemOf));
  const picks = new Set((fixture?.selectedStems ?? []).map(stemOf));
  const predicate = allTruth(
    ...truth.map((t) => (typeof t === "function" ? t : parseTruth(t))),
  );
  const ranking = new Map(),
    labels = new Map(),
    groupIds = new Map();
  for (const g of data.groups ?? []) {
    for (const [i, e] of (g.ranking ?? []).entries())
      ranking.set(e.unitId, { ...e, rank: e.rank ?? i + 1 });
    for (const [id, label] of Object.entries(g.suggested ?? {}))
      labels.set(id, label);
    for (const id of g.unitIds) groupIds.set(id, g.id);
  }
  const rows = data.units.flatMap((unit, i) => {
    const item = items.get(unit.primaryItemId) ?? {};
    const name = stemOf(item.name);
    if (scope && !scope.has(name)) return [];
    const members = [...new Set([unit.primaryItemId, ...(unit.itemIds ?? [])])]
      .map((id) => items.get(id))
      .filter(Boolean);
    const r = results.get(unit.id) ?? {},
      m = r.metrics ?? {};
    const scores = { rankingScore: ranking.get(unit.id)?.score };
    for (const key of [
      "sharpness",
      "quality",
      "aesthetic",
      "exposure",
      "faces",
    ])
      if (Number.isFinite(m[key])) scores[key] = m[key];
    if (Number.isFinite(m.eyesOpen)) scores.eyesOpen = m.eyesOpen;
    else if (Number.isFinite(m.eyesClosed)) scores.eyesOpen = -m.eyesClosed;
    for (const [key, value] of Object.entries(r.signals ?? {}))
      if (Number.isFinite(value)) scores[`signals.${key}`] = value;
    const rawTime = members.find((x) => x.captureTime != null)?.captureTime;
    const time = typeof rawTime === "number" ? rawTime : Date.parse(rawTime);
    return [
      {
        id: `${index}:${i}`,
        group: `${index}:${groupIds.get(unit.id) ?? unit.id}`,
        name,
        time: Number.isFinite(time) ? time : null,
        pick: truth.length ? members.some(predicate) : picks.has(name),
        scores,
        rank: ranking.get(unit.id)?.rank ?? Infinity,
        label: labels.get(unit.id),
      },
    ];
  });
  return { rows, session: fixture?.session ?? run ?? `会话 ${index + 1}`, run };
}
const groupsOf = (rows) => {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  return [...groups.values()];
};
const scoreSort = (a, b) =>
  (Number.isFinite(b.scores.rankingScore) ? b.scores.rankingScore : -Infinity) -
    (Number.isFinite(a.scores.rankingScore)
      ? a.scores.rankingScore
      : -Infinity) || a.id.localeCompare(b.id);
const filenameSort = (a, b) =>
  a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id);
const timeSort = (a, b) =>
  a.time != null && b.time != null
    ? a.time - b.time || filenameSort(a, b)
    : a.time != null
      ? -1
      : b.time != null
        ? 1
        : filenameSort(a, b);
function metrics(
  rows,
  groups,
  order,
  browseOrder,
  budgets,
  labels,
  scoreValue,
  featureAuc,
) {
  const picks = rows.filter((r) => r.pick).length;
  const selected = rows.filter((r) => labels.get(r.id) === "selected"),
    kept = rows.filter((r) =>
      ["selected", "candidate"].includes(labels.get(r.id)),
    );
  const rejected = rows.filter(
    (r) => r.pick && labels.get(r.id) === "rejected",
  ).length;
  const last = picks
    ? browseOrder.reduce((last, r, i) => (r.pick ? i + 1 : last), 0)
    : 0;
  const eligible = groups.filter(
    (g) => g.length > 1 && g.filter((r) => r.pick).length === 1,
  );
  const positions = new Map(browseOrder.map((r, i) => [r.id, i]));
  const hits = eligible.filter(
    (g) =>
      g.reduce((a, b) => (positions.get(a.id) < positions.get(b.id) ? a : b))
        .pick,
  ).length;
  const names = new Set(rows.flatMap((r) => Object.keys(r.scores)));
  const metricAuc = {};
  for (const name of names) {
    if (featureAuc && name !== "rankingScore") {
      metricAuc[name] = featureAuc[name];
      continue;
    }
    const value = (r) =>
      name === "rankingScore" ? scoreValue(r) : r.scores[name];
    metricAuc[name] = auc(
      rows
        .filter((r) => r.pick)
        .map(value)
        .filter(Number.isFinite),
      rows
        .filter((r) => !r.pick)
        .map(value)
        .filter(Number.isFinite),
    );
  }
  return {
    falseRejectionRate: rate(rejected, picks),
    budgetRecall: Object.fromEntries(
      budgets.map((b) => [
        b,
        rate(
          order.slice(0, Math.floor(rows.length * b)).filter((r) => r.pick)
            .length,
          picks,
        ),
      ]),
    ),
    browse: { count: last, fraction: rate(last, rows.length) },
    auc: metricAuc,
    top1: { hits, total: eligible.length, rate: rate(hits, eligible.length) },
    selected: {
      count: selected.length,
      precision: rate(selected.filter((r) => r.pick).length, selected.length),
      recall: rate(selected.filter((r) => r.pick).length, picks),
    },
    kept: {
      count: kept.length,
      recall: rate(kept.filter((r) => r.pick).length, picks),
      picksSuggestedRejected: rejected,
    },
  };
}
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
function average(values) {
  const result = structuredClone(values[0]);
  const flat = values.map((v) => flatten(v));
  function walk(obj, prefix = "") {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") walk(v, key);
      else {
        const nums = flat.map((f) => f[key]).filter(Number.isFinite);
        obj[k] = nums.length
          ? nums.reduce((a, b) => a + b, 0) / nums.length
          : null;
      }
    }
  }
  walk(result);
  return result;
}
function calculate(rows, options, rng) {
  const groups = groupsOf(rows),
    modelOrder = [...rows].sort(scoreSort);
  const browse = groups
    .map((g) => [...g].sort((a, b) => a.rank - b.rank || scoreSort(a, b)))
    .sort((a, b) =>
      scoreSort([...a].sort(scoreSort)[0], [...b].sort(scoreSort)[0]),
    )
    .flat();
  const labels = new Map(rows.map((r) => [r.id, r.label]));
  const model = metrics(
    rows,
    groups,
    modelOrder,
    browse,
    options.budgets,
    labels,
    (r) => r.scores.rankingScore,
  );
  const evaluateOrder = (order) => {
    const ranks = new Map(order.map((r, i) => [r.id, rows.length - i]));
    const baselineLabels = new Map(
      order.map((r, i) => [
        r.id,
        i < model.selected.count
          ? "selected"
          : i < model.kept.count
            ? "candidate"
            : "rejected",
      ]),
    );
    return metrics(
      rows,
      groups,
      order,
      order,
      options.budgets,
      baselineLabels,
      (r) => ranks.get(r.id),
      model.auc,
    );
  };
  const random = [];
  for (let i = 0; i < options.randomIterations; i++) {
    const order = [...rows];
    for (let j = order.length - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      [order[j], order[k]] = [order[k], order[j]];
    }
    random.push(evaluateOrder(order));
  }
  return {
    model,
    random: average(random),
    time: evaluateOrder([...rows].sort(timeSort)),
    filename: evaluateOrder([...rows].sort(filenameSort)),
  };
}
// Resample whole groups, assigning fresh identities to each sampled copy.
// Unequal cluster sizes intentionally produce unequal bootstrap populations.
function reportRows(rows, options, meta) {
  const rng = seededRandom(options.seed),
    groups = groupsOf(rows);
  const strategies = calculate(rows, options, rng);
  const samples = Object.fromEntries(
    Object.keys(strategies).map((k) => [k, {}]),
  );
  for (let i = 0; i < options.bootstrap; i++) {
    const sample = groups.flatMap((_, j) =>
      groups[Math.floor(rng() * groups.length)].map((r) => ({
        ...r,
        id: `${j}:${r.id}`,
        group: `${j}:${r.group}`,
      })),
    );
    const stats = calculate(sample, options, rng);
    for (const [strategy, result] of Object.entries(stats))
      for (const [key, value] of Object.entries(flatten(result)))
        if (Number.isFinite(value)) (samples[strategy][key] ??= []).push(value);
  }
  for (const [strategy, result] of Object.entries(strategies)) {
    result.ci = Object.fromEntries(
      Object.keys(flatten(result)).map((key) => {
        const values = (samples[strategy][key] ??= []).sort((a, b) => a - b);
        const quantile = (p) => {
          const x = (values.length - 1) * p,
            l = Math.floor(x);
          return values.length
            ? values[l] + (values[Math.ceil(x)] - values[l]) * (x - l)
            : null;
        };
        return [
          key,
          {
            low: quantile(0.025),
            high: quantile(0.975),
            samples: values.length,
          },
        ];
      }),
    );
  }
  const withPick = groups.filter((g) => g.length > 1 && g.some((r) => r.pick));
  const legacyHits = withPick.filter(
    (g) => [...g].sort((a, b) => a.rank - b.rank)[0].pick,
  ).length;
  return {
    ...meta,
    units: rows.length,
    picks: rows.filter((r) => r.pick).length,
    groups: {
      total: groups.length,
      multi: groups.filter((g) => g.length > 1).length,
      singles: groups.filter((g) => g.length === 1).length,
      multiWithPick: withPick.length,
    },
    legacyTop1: {
      hits: legacyHits,
      total: withPick.length,
      rate: rate(legacyHits, withPick.length),
      randomBaseline: rate(
        withPick.reduce(
          (s, g) => s + g.filter((r) => r.pick).length / g.length,
          0,
        ),
        withPick.length,
      ),
    },
    ...strategies,
  };
}
/** Evaluate each session and the pooled units (not an average of session rates). */
export function evaluateSessions(sessions, opts = {}) {
  const options = {
    budgets: [0.3],
    bootstrap: 1000,
    seed: 42,
    randomIterations: 100,
    truth: [],
    ...opts,
  };
  if (!sessions.length) throw new Error("至少需要一个会话");
  if (
    !options.budgets.length ||
    options.budgets.some((b) => !Number.isFinite(b) || b < 0 || b > 1)
  )
    throw new Error("budget 必须在 0–1 之间");
  for (const key of ["bootstrap", "randomIterations", "seed"])
    if (
      !Number.isSafeInteger(options[key]) ||
      options[key] < (key === "randomIterations" ? 1 : 0)
    )
      throw new Error(`${key} 必须为有效整数`);
  const prepared = sessions.map((s, i) => prepare(s, options.truth, i));
  return {
    options,
    sessions: prepared.map(({ rows, ...meta }) =>
      reportRows(rows, options, meta),
    ),
    summary: reportRows(
      prepared.flatMap((s) => s.rows),
      options,
      { session: "汇总" },
    ),
  };
}
export function evaluatePicks(data, fixture, options = {}) {
  return evaluateSessions([{ data, fixture }], options).sessions[0];
}
export function formatMarkdown(report) {
  const fmt = (v, key) =>
    v == null
      ? "无数据"
      : key.startsWith("auc.")
        ? v.toFixed(3)
        : key.endsWith("count") ||
            key.endsWith("hits") ||
            key.endsWith("total") ||
            key.endsWith("Rejected")
          ? v.toFixed(1)
          : `${(v * 100).toFixed(1)}%`;
  return (
    [...report.sessions, report.summary]
      .map((s) => {
        const rows = [
          ["精选误拒率", "falseRejectionRate"],
          ...report.options.budgets.map((b) => [
            `预算 ${b * 100}% 精选召回`,
            `budgetRecall.${b}`,
          ]),
          ["找全精选浏览张数", "browse.count"],
          ["浏览占比", "browse.fraction"],
          ...Object.keys(s.model.auc).map((k) => [`AUC ${k}`, `auc.${k}`]),
          ["组内 top-1（唯一精选）", "top1.rate"],
          ["selected 数量", "selected.count"],
          ["selected 精确率", "selected.precision"],
          ["selected 召回", "selected.recall"],
          ["kept 数量", "kept.count"],
          ["kept 召回", "kept.recall"],
        ];
        const flat = Object.fromEntries(
          ["model", "random", "time", "filename"].map((k) => [
            k,
            flatten(s[k]),
          ]),
        );
        return (
          `### ${s.session}\n\n${s.units} 单元，${s.picks} 精选；` +
          `旧口径 top-1 ${s.legacyTop1.hits}/${s.legacyTop1.total}。\n\n` +
          "| 指标 | 模型 | 随机 | 时间顺序 | 文件名顺序 | 95% CI（模型 / 随机 / 时间 / 文件名） |\n" +
          "|---|---:|---:|---:|---:|---|\n" +
          rows
            .map(
              ([label, key]) =>
                `| ${label} | ${["model", "random", "time", "filename"].map((k) => fmt(flat[k][key], key)).join(" | ")} | ${[
                  "model",
                  "random",
                  "time",
                  "filename",
                ]
                  .map((k) => {
                    const ci = s[k].ci[key];
                    return ci
                      ? `[${fmt(ci.low, key)}, ${fmt(ci.high, key)}]`
                      : "无数据";
                  })
                  .join(" / ")} |`,
            )
            .join("\n")
        );
      })
      .join("\n\n") + "\n"
  );
}
