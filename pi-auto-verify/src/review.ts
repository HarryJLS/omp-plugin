import type { Review } from "./state.ts";

export function parseReview(text: string, generation: number): Review {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("审查结果不是对象。");
  const value = data as Record<string, unknown>;
  if ((value.verdict !== "pass" && value.verdict !== "concern") || typeof value.reason !== "string" ||
      !value.reason.trim() || !Array.isArray(value.issues) ||
      value.issues.some((item) => typeof item !== "string" || !item.trim()) ||
      (value.verdict === "pass" && value.issues.length > 0) ||
      (value.verdict === "concern" && value.issues.length === 0)) {
    throw new Error("审查结果不符合协议；不能推断为通过。");
  }
  return { generation, verdict: value.verdict, reason: value.reason, issues: value.issues as string[] };
}

export function excerpt(text: string, limit = 6000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.floor(limit / 2))}\n[内容截断；中间部分未知]\n${text.slice(-Math.floor(limit / 2))}`;
}
