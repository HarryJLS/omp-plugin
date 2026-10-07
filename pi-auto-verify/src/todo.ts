/**
 * 跟踪**本任务**的 todo 列表状态，用于决定结束前是否检查验收、以及是否强制继续。
 *
 * 两个判断是分开的：
 * - `used`：本任务是否用 todo 列表跟踪过（出现过含任务的合法快照）——决定扩展是否介入。
 * - `open`：最后一个快照里仍未完成的数量——决定是否强制续跑。
 *
 * 快照只从本任务的 `todo` 工具结果累积，不在每次 settle 时回放整个分支：分支里还留着更早
 * 的用户任务，按分支判断会让没有用过 todo 的新任务误触发。
 *
 * `details` 的形状判定与 rpiv-todo 自己的 `state/replay.ts` 保持一致（`tasks` 数组 +
 * 数字 `nextId`），这样接受/忽略的范围与它回放时完全相同。
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TodoTask {
  id: number | string;
  subject: string;
  status: TodoStatus;
  [key: string]: unknown;
}

export interface TaskDetails {
  tasks: TodoTask[];
  nextId: number;
}

export interface TodoSnapshot {
  /** 本任务是否出现过含任务的合法 todo 快照。 */
  readonly used: boolean;
  /** 最后一个合法快照里 pending/in_progress 的数量。 */
  readonly open: number;
  /** 未完成任务的 `#id subject` 摘要，最多前 8 项。 */
  readonly openSummaries: string[];
}

export const EMPTY_TODO_SNAPSHOT: TodoSnapshot = { used: false, open: 0, openSummaries: [] };

const MAX_SUMMARIES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 与 rpiv-todo 的 `isTaskDetails` 相同的形状判别，用于安静跳过旧版本或损坏的结果。
 * 版本升级时两侧必须一起改，否则快照会被整体忽略。
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
  if (!isRecord(value)) return false;
  return Array.isArray(value.tasks) && typeof value.nextId === "number";
}

export function isOpenStatus(status: unknown): boolean {
  return status === "pending" || status === "in_progress";
}

function summarize(task: Record<string, unknown>, fallbackId: number): string {
  const id = typeof task.id === "number" || typeof task.id === "string" ? task.id : fallbackId;
  const subject = typeof task.subject === "string" && task.subject.trim() ? task.subject.trim() : "未命名任务";
  return `#${id} ${subject}`;
}

/** 把一个合法快照并入当前任务的记录：`used` 只增不减，`open` 与摘要取最后一次。 */
export function mergeTodoSnapshot(current: TodoSnapshot, details: TaskDetails): TodoSnapshot {
  const openSummaries: string[] = [];
  for (const [index, task] of details.tasks.entries()) {
    if (!isRecord(task) || !isOpenStatus(task.status)) continue;
    openSummaries.push(summarize(task, index + 1));
  }
  return {
    used: current.used || details.tasks.length > 0,
    open: openSummaries.length,
    openSummaries: openSummaries.slice(0, MAX_SUMMARIES),
  };
}
