import { taskLabels } from "./task-labels.js";

export function taskHistoryPage(tasks, {page=0,pageSize=20,query=""}={}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("Invalid task history page size");
  const needle=query.trim().toLocaleLowerCase();
  const matching=needle ? tasks.filter(task=>{
    const labels=taskLabels(task);
    return [task.taskId,task.taskType,task.status,labels.type,labels.status].join(" ").toLocaleLowerCase().includes(needle);
  }) : tasks;
  const pages=Math.max(1,Math.ceil(matching.length/pageSize));
  const current=Math.max(0,Math.min(pages-1,Number.isFinite(page) ? Math.floor(page) : 0));
  return {page:current,pages,total:matching.length,items:matching.slice(current*pageSize,(current+1)*pageSize)};
}
