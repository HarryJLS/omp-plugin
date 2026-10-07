export type Kind = "smoke" | "e2e";
export type Status = "idle" | "pending" | "evidence_complete" | "verified" | "blocked" | "not_applicable" | "unverified";

export interface Criterion {
  id: string;
  description: string;
  kind: Kind;
  mode: "runtime" | "visual";
}

export interface Plan {
  task: "change" | "bug" | "investigation" | "docs";
  surface: "cli" | "api" | "web" | "native" | "library";
  criteria: Criterion[];
  baselineUnavailableReason?: string;
}

export interface Evidence {
  id: string;
  tool: string;
  input: string;
  output: string;
  revision: number;
  runtime: boolean;
  visual: boolean;
}

export interface Proof {
  kind: Kind;
  revision: number;
  criteria: string[];
  evidence: Evidence[];
  summary: string;
}

export interface Review {
  generation: number;
  verdict: "pass" | "concern" | "unavailable";
  reason: string;
  issues: string[];
}

export class VerificationState {
  revision = 0;
  generation = 0;
  dirty = false;
  rounds = 0;
  status: Status = "idle";
  reason = "";
  plan?: Plan;
  review?: Review;
  reviewCalls = 0;
  proofs = new Map<string, Proof>();
  reproductions = new Map<string, Proof>();
  readonly maxRounds: number;
  readonly requireE2E: boolean;
  readonly reviewer: boolean;

  constructor(maxRounds: number, requireE2E: boolean, reviewer = false) {
    this.maxRounds = maxRounds;
    this.requireE2E = requireE2E;
    this.reviewer = reviewer;
  }

  setPlan(plan: Plan): void {
    if (!plan.criteria.length || plan.criteria.length > 12) throw new Error("验收标准须为 1 到 12 条。");
    const ids = new Set(plan.criteria.map((c) => c.id));
    if (ids.size !== plan.criteria.length || plan.criteria.some((c) => !/^[a-zA-Z0-9_-]{1,40}$/.test(c.id) || !c.description.trim())) {
      throw new Error("验收编号必须唯一，使用字母、数字、下划线或连字符；描述不能为空。");
    }
    if (!plan.criteria.some((c) => c.kind === "smoke")) throw new Error("验收清单必须包含实际冒烟验证。");
    if (this.requireE2E && !plan.criteria.some((c) => c.kind === "e2e")) throw new Error("项目配置要求 E2E，清单不能省略。");
    if (["web", "native"].includes(plan.surface) && !plan.criteria.some((c) => c.mode === "visual")) {
      throw new Error("Web/桌面任务必须包含真实界面的视觉证据要求。");
    }
    if (this.plan) {
      if (this.plan.task !== plan.task || this.plan.surface !== plan.surface ||
          this.plan.criteria.some((old) => !plan.criteria.some((c) =>
            c.id === old.id && c.description === old.description && c.kind === old.kind && c.mode === old.mode))) {
        throw new Error("同一任务的验收清单只能补充，不能删除、改写或降低已声明标准。");
      }
    }
    if (JSON.stringify(this.plan) === JSON.stringify(plan)) return;
    this.plan = structuredClone(plan);
    this.generation++;
    if (plan.task !== "docs") this.dirty = true;
  }

  criteria(ids: string[], kind: Kind): Criterion[] {
    if (!this.plan) throw new Error("先调用 verify_plan 声明本任务的验收标准。");
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error("必须引用至少一条不同的验收编号。");
    return ids.map((id) => {
      const criterion = this.plan?.criteria.find((c) => c.id === id);
      if (!criterion || criterion.kind !== kind) throw new Error(`未知验收编号或验证类型不匹配：${id}`);
      return criterion;
    });
  }

  changed(): void {
    this.revision++;
    this.generation++;
    this.dirty = true;
    this.status = "pending";
    this.reason = "";
    this.proofs.clear();
  }

  attempt(kind: Kind, ids: string[]): void {
    this.criteria(ids, kind);
    this.dirty = true;
    for (const id of ids) this.proofs.delete(id);
    this.generation++;
    this.status = "pending";
    this.reason = "";
  }

  accept(proof: Proof): boolean {
    const criteria = this.criteria(proof.criteria, proof.kind);
    if (proof.revision !== this.revision || !proof.evidence.length ||
        proof.evidence.some((e) => e.revision !== this.revision)) return false;
    const runtime = proof.evidence.some((e) => e.runtime);
    const visual = proof.evidence.some((e) => e.visual);
    if (!runtime || criteria.some((c) => c.mode === "visual" && !visual)) return false;
    for (const criterion of criteria) this.proofs.set(criterion.id, structuredClone(proof));
    this.generation++;
    return true;
  }

  reproduce(proof: Proof): void {
    this.criteria(proof.criteria, proof.kind);
    if (this.plan?.task !== "bug" || this.revision !== 0 || proof.revision !== 0) {
      throw new Error("修复前复现必须在本任务第一次修改之前执行；无法复现时在计划中如实注明原因。");
    }
    for (const id of proof.criteria) this.reproductions.set(id, structuredClone(proof));
    this.generation++;
  }

  finish(status: "blocked" | "not_applicable", reason: string): void {
    if (!reason.trim()) throw new Error("必须说明具体原因。");
    this.status = status;
    this.reason = reason;
    this.proofs.clear();
    this.generation++;
  }

  missing(): string[] {
    if (!this.plan) return ["验收计划"];
    const missing = this.plan.criteria.filter((c) => this.proofs.get(c.id)?.revision !== this.revision).map((c) => c.id);
    if (this.plan.task === "bug" && !this.reproductions.size && !this.plan.baselineUnavailableReason?.trim()) {
      missing.push("修复前复现，或无法复现的具体说明");
    }
    if (this.reviewer && (this.review?.generation !== this.generation || this.review.verdict !== "pass")) {
      missing.push("独立审查");
    }
    return missing;
  }

  readyForReview(): boolean {
    return !!this.plan && this.missing().every((item) => item === "独立审查");
  }

  /** `canContinue` 为 false 时不能继续本轮任务，`unavailableReason` 说明具体原因。 */
  settle(canContinue: boolean, unavailableReason = "当前会话不能继续运行。"): boolean {
    if (!this.dirty || this.status === "blocked" || this.status === "not_applicable") return false;
    if (this.missing().length === 0) {
      this.status = this.reviewer ? "verified" : "evidence_complete";
      return false;
    }
    if (!canContinue || this.rounds >= this.maxRounds) {
      this.status = "unverified";
      this.reason = canContinue ? "自动验证续跑次数已用尽。" : unavailableReason;
      return false;
    }
    this.status = "pending";
    this.rounds++;
    return true;
  }

  report() {
    const evidence = new Map<string, Evidence>();
    const summarize = (proof: Proof | undefined) => {
      if (!proof) return undefined;
      for (const record of proof.evidence) evidence.set(record.id, record);
      return {
        kind: proof.kind, revision: proof.revision, summary: proof.summary,
        evidenceIds: proof.evidence.map((record) => record.id),
      };
    };
    const criteria = this.plan?.criteria.map((c) => ({
      ...c,
      status: this.proofs.get(c.id)?.revision === this.revision ? "evidence_complete" : "missing",
      proof: summarize(this.proofs.get(c.id)),
      reproduction: summarize(this.reproductions.get(c.id)),
    })) ?? [];
    return {
      status: this.status,
      revision: this.revision,
      rounds: this.rounds,
      missing: this.missing(),
      reason: this.reason,
      plan: this.plan,
      criteria,
      evidence: [...evidence.values()],
      review: this.review ? { ...this.review, current: this.review.generation === this.generation } : undefined,
      reviewCalls: this.reviewCalls,
    };
  }
}
