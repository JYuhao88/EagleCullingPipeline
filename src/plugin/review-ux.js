export const REVIEW_WELCOME_KEY = 'eagle-culling:review-welcome:v1';

export function createReviewUx({ root, storage }) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { /* The host can deny access to storage itself. */ }
  }
  const q = id => root.querySelector(`#${id}`);
  let dismissed = false;
  try { dismissed = storage?.getItem(REVIEW_WELCOME_KEY) === 'dismissed'; } catch { /* Embedded storage may be disabled. */ }
  const show = id => {
    const dialog = q(id);
    if (!dialog.open) dialog.showModal();
    q('reviewMore').open = false;
  };
  const dismiss = () => {
    dismissed = true;
    try { storage?.setItem(REVIEW_WELCOME_KEY, 'dismissed'); } catch { /* Keep the in-session choice. */ }
  };
  for (const id of ['reviewHelp', 'allShortcuts']) q(id).addEventListener('click', () => show('shortcutHelp'));
  for (const id of ['reopenReviewWelcome', 'helpReviewWelcome']) q(id).addEventListener('click', () => {
    q('shortcutHelp').close(); show('reviewWelcome');
  });
  for (const id of ['dismissReviewWelcome', 'closeReviewWelcome']) q(id).addEventListener('click', () => {
    dismiss(); q('reviewWelcome').close();
  });
  q('reviewWelcome').addEventListener('cancel', dismiss);
  q('openReviewSettings').addEventListener('click', () => show('reviewSettings'));
  q('closeReviewSettings').addEventListener('click', () => q('reviewSettings').close());
  q('openFinish')?.addEventListener('click', () => show('finishDialog'));
  q('closeFinish')?.addEventListener('click', () => q('finishDialog').close());
  // Results are reported in the review toast, which an open modal would cover.
  for (const id of ['acceptUnreviewed', 'acceptHighConfidence', 'acceptSingles', 'dryRun', 'revertWriteback']) {
    q(id)?.addEventListener('click', () => q('finishDialog')?.close());
  }
  q('writeback')?.addEventListener('click', event => {
    if (!event.target.closest?.('a')) q('writeback').textContent = '';
  });
  return { enter: () => { if (!dismissed) { const hint = q('reviewWelcome'); if (hint.show) hint.show(); else hint.open = true; } } };
}
