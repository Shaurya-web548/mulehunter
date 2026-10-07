/** Client-safe display helpers for paise amounts and times. */
import { minorToInr } from "../contracts/money.ts";

export const inrMinor = (m: number | null | undefined) => (m === null || m === undefined ? "—" : minorToInr(m));

export function timeOf(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTimeOf(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ago(ms: number | null | undefined, now: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-5)}` : id);
