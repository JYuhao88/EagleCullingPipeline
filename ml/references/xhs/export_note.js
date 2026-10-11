// Exports the currently open Xiaohongshu note (text, tags, counts, loaded comments) as JSON.
// Never collects nicknames, avatars, or profile links.
(() => {
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const text = (el) => (el ? el.innerText.trim() : "");
  const count = (sel, root) => {
    const t = text(q(sel, root));
    if (!t) return null;
    const m = t.match(/([\d.]+)\s*(万|w)?/i);
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * (m[2] ? 10000 : 1));
  };

  const noteId = (location.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-f]+)/) || [])[1] || null;
  const container = q("#noteContainer") || q(".note-container") || document;
  const returnMode = Boolean(window.__xhsExportReturn);
  if (!q("#detail-desc", container) && !q("#detail-title", container)) {
    if (returnMode) return JSON.stringify({ error: "no-note", url: location.href });
    alert("没找到笔记内容：请先打开一篇笔记详情再点击。");
    return;
  }

  const comment = (el) => ({
    text: text(q(".content", el) || q(".note-text", el)),
    likes: count(".like .count, .like-wrapper .count", el),
    isAuthor: /作者/.test(text(q(".tag", el))),
    date: text(q(".date", el)) || null,
  });

  const comments = qa(".parent-comment", container).map((p) => {
    const top = q(".comment-item", p) || p;
    return {
      ...comment(top),
      replies: qa(".reply-container .comment-item, .comment-item-sub", p).map(comment),
    };
  });

  const imgs = qa(".swiper-slide:not(.swiper-slide-duplicate) img, .media-container img", container);
  const out = {
    source: "xiaohongshu",
    contractVersion: 1,
    noteId,
    url: noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : location.origin + location.pathname,
    capturedAt: new Date().toISOString(),
    title: text(q("#detail-title", container)),
    desc: text(q("#detail-desc .note-text", container) || q("#detail-desc", container)),
    tags: qa("#detail-desc a.tag, #hash-tag", container).map((a) => text(a)).filter(Boolean),
    date: text(q(".bottom-container .date", container)) || null,
    imageCount: new Set(imgs.map((i) => i.src)).size,
    counts: {
      likes: count(".interact-container .like-wrapper .count", container),
      collects: count(".interact-container .collect-wrapper .count", container),
      comments: count(".interact-container .chat-wrapper .count", container),
    },
    comments,
    loadedComments: comments.length + comments.reduce((n, c) => n + c.replies.length, 0),
  };

  if (returnMode) return JSON.stringify(out);

  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `xhs-${noteId || "note"}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  const tip = document.createElement("div");
  tip.textContent = `已导出：${out.comments.length} 条评论（含回复共 ${out.loadedComments}）`;
  Object.assign(tip.style, {
    position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)", zIndex: 99999,
    background: "#222", color: "#fff", padding: "8px 16px", borderRadius: "8px", fontSize: "14px",
  });
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 2500);
})();
