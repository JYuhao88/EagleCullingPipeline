// A generated PNG is not proof of an Eagle write. Only successful write tasks count.
export function registeredThumbnailIds(tasks, libraryPath) {
  const latest = new Map();
  for (const task of [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (task.libraryPath !== libraryPath) continue;
    for (const item of task.items || []) {
      if (item.status !== "succeeded") continue;
      if (task.taskType.startsWith("badge-thumbnails") && item.outputPath) latest.set(item.id, true);
      else if (["restore-thumbnails", "restore-thumbnail-backups"].includes(task.taskType)) latest.set(item.id, false);
    }
  }
  return new Set([...latest].filter(([, applied]) => applied).map(([id]) => id));
}
