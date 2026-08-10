import type { Pattern } from "./engine/types";

export function inr(n: number): string {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000) return `${(n / 100_000).toFixed(2)} L`;
  return Math.round(n).toLocaleString("en-IN");
}

export function patternLabel(p: Pattern | "unknown"): string {
  return p === "fanout_layering"
    ? "Fan-out layering"
    : p === "circular_routing"
      ? "Circular routing"
      : p === "smurfing"
        ? "Smurfing"
        : "Unclassified";
}
