(() => {
  const base = location.protocol === "file:" ? "http://127.0.0.1:43126" : "";
  const $ = (id) => document.getElementById(id);
  let rules = [],
    selected,
    existingIds = new Set();
  const labels = {
    proposed: "待审核",
    existing: "已有",
    reference: "其他库证据（只读）",
    approved: "已通过",
    merged: "已合并",
    deleted: "已删除",
  };
  const element = (tag, text, parent) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent?.append(node);
    return node;
  };
  const message = (text) => {
    $("message").textContent = text;
  };
  async function request(route, body) {
    const response = await fetch(
      `${base}/rules/${route}`,
      body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  }
  async function load() {
    const data = await request("data");
    rules = [...data.rules, ...(data.referenceRules || [])].sort(
      (a, b) => (b.frequency?.episodes ?? b.frequency?.videos ?? b.supportEpisodes ?? 0) -
        (a.frequency?.episodes ?? a.frequency?.videos ?? a.supportEpisodes ?? 0) ||
        (b.frequency?.segments ?? b.supportSegments ?? 0) - (a.frequency?.segments ?? a.supportSegments ?? 0),
    );
    existingIds = new Set(data.existingIds || []);
    $("version").textContent = `种子 v${data.version} · ${rules.length} 条规则`;
    const previous = $("aspect").value;
    $("aspect").replaceChildren(
      new Option("全部", ""),
      ...[...new Set(rules.map((rule) => rule.aspect))].sort().map((aspect) => new Option(aspect, aspect)),
    );
    $("aspect").value = previous;
    selected ||= sortedRules()[0]?.id;
    renderList();
    renderDetail();
  }
  function sortedRules() {
    if ($("sort")?.value === "frequency") return rules;
    return [...rules].sort((a, b) =>
      (a.reviewSuggestion?.rank ?? Infinity) - (b.reviewSuggestion?.rank ?? Infinity) ||
      Number(!!a.reviewSuggestion?.isAlias) - Number(!!b.reviewSuggestion?.isAlias));
  }
  function renderList() {
    $("list").replaceChildren();
    const matchesSource = (rule) => {
      const source = $("source").value;
      const book = rule.source?.startsWith("book:") || !!rule.bookEvidence?.length;
      const paper = rule.source === "paper" || !!rule.paperEvidence?.length;
      const course = rule.source?.startsWith("course:") || !!rule.courseEvidence?.length;
      const wulin = rule.source === "wulin-critiques" || !!rule.wulinEvidence?.length ||
        rule.evidence?.some((item) => item.source === "wulin-critiques");
      return !source || (source === "book" ? book : source === "paper" ? paper : source === "course" ? course
        : source === "wulin" ? wulin : !book && !paper && !course && !wulin);
    };
    for (const rule of sortedRules().filter(
      (rule) =>
        (!$("aspect").value || rule.aspect === $("aspect").value) &&
        (!$("status").value || rule.status === $("status").value) &&
        matchesSource(rule),
    )) {
      const button = element("button", rule.title, $("list"));
      if (Number.isFinite(rule.reviewSuggestion?.rank)) element("small",
        `优先级 #${rule.reviewSuggestion.rank}${rule.reviewSuggestion.isAlias ? " · 归并别名建议" : ""}`, button);
      if (rule.id === selected) button.className = "selected";
      element(
        "small",
        `${rule.id} · ${labels[rule.status] || rule.status} · ` +
          (rule.source?.startsWith("course:")
            ? `课程 · ${rule.library || "portrait"}`
            : rule.source === "paper"
            ? `论文 · ${rule.library || "portrait"}`
            : rule.source?.startsWith("book:")
            ? `书籍 · ${rule.library || "portrait"}`
            : `${rule.source === "wulin-critiques" || rule.wulinEvidence?.length ? "武林 · " : ""}` +
              `${rule.frequency?.episodes ?? rule.frequency?.videos ?? rule.supportEpisodes ?? 0} 期 / ` +
              `${rule.frequency?.segments ?? rule.supportSegments ?? 0} 段`),
        button,
      );
      button.onclick = () => {
        selected = rule.id;
        renderList();
        renderDetail();
      };
    }
  }
  async function decide(action, patch, targetId) {
    try {
      await request("decisions", {
        ruleId: selected,
        action,
        ...(patch ? { patch } : {}),
        ...(targetId ? { targetId } : {}),
      });
      await load();
      message("审核决定已保存。");
    } catch (error) {
      message(error.message);
    }
  }
  function renderDetail() {
    const area = $("detail");
    area.replaceChildren();
    const rule = rules.find((item) => item.id === selected);
    if (!rule) {
      element("p", "暂无规则。", area);
      return;
    }
    element("h2", rule.title, area);
    element("small", `${rule.id} · ${rule.aspect} · ${labels[rule.status] || rule.status}`, area);
    if (rule.reviewSuggestion) {
      const suggestion = rule.reviewSuggestion;
      const actions = { approve: "通过", merge: "归并", reject: "不采纳", "needs-measure": "补充测量" };
      element("h3", "归并建议（非审核决定）", area);
      element("p", `优先级 ${suggestion.rank ? `#${suggestion.rank}` : "未排序"} · ` +
        `建议动作：${actions[suggestion.recommendation] || suggestion.recommendation || "待核对"}`, area);
      if (suggestion.isAlias) element("p", `建议并入主条目：${suggestion.mainId}`, area);
      if (suggestion.aliases?.length) element("p",
        `主条目 ${suggestion.mainId} · 建议别名：${suggestion.aliases.join("、")}`, area);
      if (suggestion.mergeReason) element("p", suggestion.mergeReason, area);
      element("p", "建议只供人工核对，不会自动保存决定。候选间归并仅展示建议；" +
        "下方合并按钮只支持并入已有的人像规则。", area);
    }
    if (rule.polarity) element("p", `方向：${rule.polarity === "positive" ? "正面加分" : "负面问题"}`, area);
    if (rule.tierContrast) element("p",
      `档位段数：低档 ${rule.tierContrast.low} / 高档 ${rule.tierContrast.high} / 未归入两档 ${rule.tierContrast.unknown}（仅观察频次）`, area);
    if (rule.check?.signal) element("p", `测量信号：${[].concat(rule.check.signal).join("、")}`, area);
    if (rule.check?.limitations) element("p", `测量限制：${rule.check.limitations}`, area);
    const field = (title, tag, value) => {
      const label = element("label", title, area);
      const input = element(tag, undefined, label);
      input.value = value;
      return input;
    };
    const statement = field("规则陈述", "textarea", rule.statement);
    const severity = field("严重度", "select", "");
    severity.replaceChildren(...["gate", "penalty", "hint"].map((value) => new Option(value, value)));
    severity.value = rule.severity;
    const checker = field("检查方式 check.by", "select", "");
    checker.replaceChildren(
      ...["measure", "teacher", "measure+teacher"].map((value) => new Option(value, value)),
    );
    checker.value = rule.check?.by;
    const exceptions = field("例外（每行一条）", "textarea", (rule.exceptions || []).join("\n"));
    const removed = ["deleted", "merged", "reference"].includes(rule.status);
    if (rule.status === "reference") {
      element("p", "此处展示其他规则库的累积证据；正式规则只读。", area);
      for (const input of [statement, severity, checker, exceptions]) input.disabled = true;
    }
    const actions = element("div", undefined, area);
    actions.className = "actions";
    const patch = () => ({
      statement: statement.value.trim(),
      severity: severity.value,
      check: { by: checker.value },
      exceptions: exceptions.value
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
    });
    for (const [label, action, edited] of [
      ["通过", "approve", false],
      ["保存修改", "modify", true],
      ["删除", "delete", false],
    ]) {
      const button = element("button", label, actions);
      button.disabled = removed;
      button.onclick = () => decide(action, edited ? patch() : undefined);
    }
    if (rule.source?.startsWith("book:") && rule.library && rule.library !== "portrait")
      element("p", "此候选可独立审核；导出时按所属规则库单独下载书籍草案。", area);
    if (rule.source === "paper" && rule.library && rule.library !== "portrait")
      element("p", "此候选可独立审核；导出时按所属规则库单独下载论文草案。", area);
    if (rule.source?.startsWith("course:") && rule.library && rule.library !== "portrait")
      element("p", "此候选可独立审核；导出时按所属规则库单独下载课程草案。", area);
    if (rule.source === "wulin-critiques")
      element("p", "此候选可独立审核；导出时按所属规则库单独下载武林草案。", area);
    if (rule.wulinFrequency) element("p",
      `武林支持：${rule.wulinFrequency.episodes ?? rule.wulinFrequency.videos ?? 0} 期 / ${rule.wulinFrequency.segments ?? 0} 段`, area);
    const target = field("合并到已有规则", "select", "");
    target.replaceChildren(
      new Option("选择规则", ""),
      ...rules
        .filter(
          (item) =>
            item.id !== rule.id && existingIds.has(item.id) && ["existing", "approved"].includes(item.status),
        )
        .map((item) => new Option(`${item.id} ${item.title}`, item.id)),
    );
    const merge = element("button", "合并", area);
    merge.disabled = removed || existingIds.has(rule.id) || (!!rule.library && rule.library !== "portrait");
    merge.onclick = () =>
      target.value ? decide("merge", undefined, target.value) : message("请先选择合并目标。");
    if (rule.bookEvidence?.length) {
      element("h3", "书籍出处/例外", area);
      const kinds = { source: "出处", exception: "例外", counterpoint: "补充观点" };
      for (const evidence of rule.bookEvidence) {
        const card = element("div", undefined, area);
        card.className = "evidence";
        element("p", evidence.paraphrase, card);
        const citation = [kinds[evidence.kind] || "出处", evidence.book?.title || evidence.bookSlug,
          evidence.book?.author, evidence.locator].filter(Boolean).join(" · ");
        element("small", citation, card);
      }
    }
    if (rule.paperEvidence?.length) {
      element("h3", "论文出处/例外", area);
      const kinds = { source: "出处", exception: "例外", counterpoint: "反向提醒" };
      for (const evidence of rule.paperEvidence) {
        const card = element("div", undefined, area);
        card.className = "evidence";
        element("p", evidence.paraphrase, card);
        element("small", `${kinds[evidence.kind] || "出处"} · 支持 ${evidence.supportCount || 1} 篇`, card);
        for (const support of evidence.supports?.length ? evidence.supports : [evidence]) {
          element("p", [support.paper?.title || support.paperSlug, support.paper?.year,
            support.paper?.channel, support.locator].filter(Boolean).join(" · "), card);
        }
      }
    }
    if (rule.courseEvidence?.length) {
      element("h3", "课程出处/例外", area);
      const kinds = { source: "出处", exception: "例外", counterpoint: "反向提醒" };
      const timestamp = (seconds) => {
        if (!Number.isFinite(Number(seconds))) return "—";
        const whole = Math.floor(Number(seconds));
        return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
      };
      for (const evidence of rule.courseEvidence) {
        const card = element("div", undefined, area);
        card.className = "evidence";
        element("p", evidence.paraphrase, card);
        element("small", [kinds[evidence.kind] || "出处", evidence.course?.title || evidence.courseSlug,
          `支持 ${evidence.supportCount || 1} 集`].join(" · "), card);
        const supports = [...new Map([evidence, ...(evidence.supports || [])].map((support) => {
          const loc = support.locator || {};
          return [JSON.stringify([loc.source, loc.course, loc.episode, loc.start, loc.end, loc.page, loc.episodeId]), support];
        })).values()];
        for (const support of supports) {
          const locator = support.locator || {};
          element("p", [locator.course, `第 ${locator.episode ?? "—"} 集`,
            locator.page != null ? locator.episodeId : null,
            locator.page != null ? `讲义第 ${locator.page} 页` :
              `${timestamp(locator.start)}–${timestamp(locator.end)}`].filter(Boolean).join(" · "), card);
        }
      }
    }
    element("h3", "代表性出处", area);
    if (!rule.evidence?.some((item) => !item.bookSlug && !item.paperSlug && !item.courseSlug)) element("p", "暂无点评出处。", area);
    const videoEvidence = (rule.representatives || rule.evidence || [])
      .filter((item) => !item.bookSlug && !item.paperSlug && !item.courseSlug);
    for (const evidence of videoEvidence.slice(0, 4)) {
      const card = element("div", undefined, area);
      card.className = "evidence";
      element("p", evidence.paraphrase || evidence.text || "点评转述待补充", card);
      element(
        "small",
        `档位：${evidence.tier || "未识别"} · 段 ${evidence.segment ?? "—"} · ${evidence.polarity || evidence.kind || ""}`,
        card,
      );
      if (/^BV[A-Za-z0-9]+$/.test(evidence.bvid) && Number.isFinite(Number(evidence.t))) {
        const link = element("a", `${evidence.bvid} · ${Math.floor(Number(evidence.t))} 秒 ↗`, card);
        link.href = `https://www.bilibili.com/video/${evidence.bvid}?t=${Math.floor(Number(evidence.t))}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const frame = evidence.frame
          ? String(evidence.frame).replace(/^frames\//, "")
          : `${evidence.bvid}/${evidence.segment}.jpg`;
        const representative =
          rule.representatives?.some(
            (item) => item.bvid === evidence.bvid && item.segment === evidence.segment,
          ) ?? true;
        if (representative && /^(?:BV[A-Za-z0-9]+\/)?[A-Za-z0-9_-]+\.jpg$/.test(frame)) {
          const image = element("img", undefined, link);
          image.alt = "点评截图";
          image.loading = "lazy";
          const relative = frame.replace(/^frames\//, "");
          image.src = `${base}/rules/frames/${relative.split("/").map(encodeURIComponent).join("/")}`;
          image.onerror = () => image.remove();
        }
      }
    }
  }
  $("aspect").onchange = renderList;
  $("status").onchange = renderList;
  $("source").onchange = renderList;
  if ($("sort")) $("sort").onchange = renderList;
  $("export").onclick = async () => {
    try {
      const data = await request("export", {});
      const download = (draft, filename) => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }));
        const link = element("a");
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      download(data.draft, "portrait.v0.2.draft.json");
      for (const [library, draft] of Object.entries(data.bookDrafts || {}))
        download(draft, `${library}.books.draft.json`);
      for (const [library, draft] of Object.entries(data.paperDrafts || {}))
        download(draft, `${library}.papers.draft.json`);
      for (const [library, draft] of Object.entries(data.courseDrafts || {}))
        download(draft, `${library}.courses.draft.json`);
      for (const [library, draft] of Object.entries(data.wulinDrafts || {}))
        download(draft, `${library}.wulin.draft.json`);
      message(`草案已保存到 ${data.path}`);
    } catch (error) {
      message(error.message);
    }
  };
  load().catch((error) => message(`加载失败：${error.message}。请启动本地服务（端口 43126）。`));
})();
