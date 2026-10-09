// Paging is a rendering bound, never a limit on selected/processed photos.
export function reviewPage(sections, page = 0, size = 80) {
  const total = sections.reduce((count, section) => count + section.records.length, 0);
  const pages = Math.max(1, Math.ceil(total / size));
  const index = Math.max(0, Math.min(page, pages - 1));
  const start = index * size;
  const end = start + size;
  let offset = 0;
  const visible = [];
  for (const section of sections) {
    const from = Math.max(0, start - offset);
    const to = Math.min(section.records.length, end - offset);
    if (to > from) visible.push({ ...section, records: section.records.slice(from, to) });
    offset += section.records.length;
    if (offset >= end) break;
  }
  return { sections: visible, total, pages, page: index };
}
