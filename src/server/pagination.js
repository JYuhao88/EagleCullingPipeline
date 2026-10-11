export function pageOptions(url) {
  const limit = Number(url.searchParams.get('limit') || 40);
  const cursor = Number(url.searchParams.get('cursor') || 0);
  const filter = url.searchParams.get('filter') || 'all';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      !Number.isSafeInteger(cursor) || cursor < 0 || !['all', 'multi', 'confirm', 'singles', 'low-first', 'unreviewed', 'reviewed',
        'issues', 'eyes-closed', 'blurry'].includes(filter)) {
    const error = new Error('Invalid pagination (limit 1–200, nonnegative cursor, filter all/multi/confirm/singles)');
    error.statusCode = 400;
    throw error;
  }
  return { limit, cursor, filter, groupId: url.searchParams.get('groupId'), unitId: url.searchParams.get('unitId') };
}
