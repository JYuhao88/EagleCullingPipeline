export function indexedFaces(result) {
  return (Array.isArray(result?.faces) ? result.faces : []).map((face, index) => ({ ...face, index }))
    .filter(face => Array.isArray(face.box) && face.box.length === 4 && face.box.every(Number.isFinite)
      && face.box.every(value => value >= 0 && value <= 1)
      && face.box[2] > face.box[0] && face.box[3] > face.box[1]);
}

function center(face) {
  return [(face.box[0] + face.box[2]) / 2, (face.box[1] + face.box[3]) / 2];
}

function area(face) {
  return (face.box[2] - face.box[0]) * (face.box[3] - face.box[1]);
}

export function largestFaces(result, limit = 4) {
  return indexedFaces(result).sort((a, b) => area(b) - area(a)).slice(0, limit);
}

export function alignFaces(results, maxDistance = 0.18) {
  const columns = results.map(indexedFaces);
  const reference = columns.reduce((best, faces, index) => faces.length > columns[best].length ? index : best, 0);
  const rows = (columns[reference] || []).map(face => ({
    anchor: center(face), cells: columns.map((_, index) => index === reference ? face : null)
  }));
  columns.forEach((faces, column) => {
    if (column === reference) return;
    const candidates = faces.flatMap((face, faceIndex) => rows.map((row, rowIndex) => ({
      faceIndex, rowIndex, distance: Math.hypot(...center(face).map((value, axis) => value - row.anchor[axis]))
    }))).filter(pair => pair.distance <= maxDistance).sort((a, b) => a.distance - b.distance);
    const used = new Set();
    for (const pair of candidates) {
      if (used.has(pair.faceIndex) || rows[pair.rowIndex].cells[column]) continue;
      rows[pair.rowIndex].cells[column] = faces[pair.faceIndex];
      used.add(pair.faceIndex);
    }
    faces.forEach((face, index) => {
      if (!used.has(index)) rows.push({
        anchor: center(face), cells: columns.map((_, index) => index === column ? face : null)
      });
    });
  });
  return rows.sort((a, b) => a.anchor[0] - b.anchor[0] || a.anchor[1] - b.anchor[1]).map(row => row.cells);
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

export function renderFace(face, { base, runId, unitId }, label = "") {
  if (!face) return `<div class="face-tile face-empty"><span>${label} · 未匹配</span></div>`;
  const assessed = face.eyesAssessed === true;
  const closed = assessed && face.eyesClosed === true;
  const status = !assessed ? "未评估" : closed ? "闭眼" : "睁眼";
  const state = !assessed ? "face-unknown" : closed ? "face-closed" : "face-open";
  const url = `${base}/runs/${encodeURIComponent(runId)}/face/${encodeURIComponent(unitId)}/${face.index}`;
  return `<figure class="face-tile ${state}"><img src="${escape(url)}" loading="lazy" alt="${label} ${status}"
    onerror="this.style.display='none';this.parentElement.classList.add('face-unavailable')">
    <figcaption>${label}${label ? " · " : ""}${status}<span class="face-error"> · 裁剪不可用</span></figcaption></figure>`;
}

export function renderFaceStrip(result, context) {
  const faces = largestFaces(result);
  return faces.length ? `<div class="face-strip" aria-label="人脸缩略图">`
    + `${faces.map(face => renderFace(face, context)).join("")}</div>` : "";
}

export function renderNativeFace(face, { base, runId, unitId }, region = "face") {
  if (!face) return `<div class="native-tile face-empty">未匹配人脸</div>`;
  const url = `${base}/runs/${encodeURIComponent(runId)}/focus-crop/`
    + `${encodeURIComponent(unitId)}/${face.index}?region=${region === "eyes" ? "eyes" : "face"}`;
  return `<figure class="native-tile"><div class="native-viewport"><img src="${escape(url)}" loading="lazy" alt="原生像素局部"
    onerror="this.style.display='none';this.closest('figure').classList.add('native-unavailable')"></div>
    <figcaption>${region === "eyes" ? "眼部" : "脸部"} · 100%（1 像素 = 1 CSS 像素，可滚动）`
    + `<span class="native-error">原生局部不可用；可切换脸部</span></figcaption></figure>`;
}
