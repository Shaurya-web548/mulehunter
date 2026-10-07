/**
 * Case analysis — pure, explainable per-account risk scoring over a trace
 * revision plus bounded ledger context. No I/O, no simulator truth.
 *
 * Output is a heuristic RISK SCORE (0–100), not a probability or a
 * calibrated confidence. "Suspected mule" = score at/above the threshold AND
 * at least one behavioural finding with concrete transaction evidence.
 * Receiving downstream money (reachability) contributes 0 points.
 */
import { scoreAccount } from "../../engine/detect.ts";
import type { AccountWindow } from "../../engine/graph.ts";
import { minorToLegacyRupees } from "../../contracts/legacy.ts";
import { minorToInr } from "../../contracts/money.ts";
import type { LedgerEdge, NodeKind } from "../tracing/trace.ts";

export const DETECTOR_VERSION = "case-detector/v1";

export interface AnalysisConfig {
  fanWindowMs: number;
  fanOutMinRecipients: number;
  fanOutMinTotalMinor: number;
  fanInMinSenders: number;
  fanInMinTotalMinor: number;
  velocityMaxDwellMs: number;
  passThroughMinRatio: number;
  passThroughMaxRatio: number;
  structuringLowMinor: number;
  structuringHighMinor: number;
  structuringMinCount: number;
  newAccountDays: number;
  cashOutMinCount: number;
  suspectThreshold: number;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  fanWindowMs: 30 * 60_000,
  fanOutMinRecipients: 4,
  fanOutMinTotalMinor: 2_000_000, // ₹20,000
  fanInMinSenders: 6,
  fanInMinTotalMinor: 4_000_000, // ₹40,000
  velocityMaxDwellMs: 10 * 60_000,
  passThroughMinRatio: 0.8,
  passThroughMaxRatio: 1.1,
  structuringLowMinor: 880_000, // ₹8,800 — same band as the live detector
  structuringHighMinor: 1_000_000, // ₹10,000
  structuringMinCount: 3,
  newAccountDays: 7,
  cashOutMinCount: 2,
  suspectThreshold: 50,
};

export type FindingMotif = "FAN_OUT" | "FAN_IN" | "CIRCULAR" | "VELOCITY" | "STRUCTURING" | "CASH_OUT";
const BEHAVIOURAL: FindingMotif[] = ["FAN_OUT", "FAN_IN", "CIRCULAR", "VELOCITY", "STRUCTURING"];

export interface AccountContext {
  id: string;
  kind: NodeKind;
  createdAt: number;
  role: "VICTIM" | "TRACED" | "MERCHANT" | "SINK";
  /** accepted payments into / out of this account within the analysis window */
  inflows: LedgerEdge[];
  outflows: LedgerEdge[];
  /** ids of traced transfers INTO this account (the case money path) */
  tracedInTxnIds: string[];
  /** open cases where this account is the victim (cross-case role conflict) */
  victimInOtherCases: string[];
  sinkIds: Set<string>;
}

export interface FindingDraft {
  key: string;
  motif: FindingMotif;
  accountIds: string[];
  txnIds: string[];
  points: number;
  features: Record<string, number | string>;
  explanation: string;
}

export interface Contribution {
  feature: string;
  points: number;
  note: string;
}

export type Exclusion = null | "CASE_VICTIM" | "MERCHANT_OR_SINK" | "ROLE_CONFLICT" | "NO_BEHAVIOURAL_EVIDENCE" | "BELOW_THRESHOLD";

export interface CandidateDraft {
  accountId: string;
  role: AccountContext["role"];
  riskScore: number;
  contributions: Contribution[];
  suspectedMule: boolean;
  eligible: boolean;
  exclusion: Exclusion;
  features: Record<string, number | string>;
  findingKeys: string[];
}

export interface AnalysisInput {
  accounts: AccountContext[];
  cycles: { nodeIds: string[]; txnIds: string[] }[];
  now: number;
  config: AnalysisConfig;
}

export interface AnalysisOutput {
  findings: FindingDraft[];
  candidates: CandidateDraft[];
}

const byTime = (a: LedgerEdge, b: LedgerEdge) => a.ts - b.ts || a.seq - b.seq;

function fanOut(a: AccountContext, cfg: AnalysisConfig): FindingDraft | null {
  const start = firstTracedInTs(a);
  if (start === null) return null;
  const outs = a.outflows.filter((e) => e.ts >= start && e.ts <= start + cfg.fanWindowMs && !a.sinkIds.has(e.toId));
  const recipients = new Set(outs.map((e) => e.toId));
  const total = outs.reduce((s, e) => s + e.amountMinor, 0);
  if (recipients.size < cfg.fanOutMinRecipients || total < cfg.fanOutMinTotalMinor) return null;
  return {
    key: `FAN_OUT:${a.id}`,
    motif: "FAN_OUT",
    accountIds: [a.id],
    txnIds: outs.map((e) => e.txnId),
    points: Math.min(30, recipients.size * 6),
    features: { recipients: recipients.size, totalMinor: total, windowMin: cfg.fanWindowMs / 60_000 },
    explanation: `split ${minorToInr(total)} to ${recipients.size} accounts within ${cfg.fanWindowMs / 60_000} min of receiving traced funds`,
  };
}

function fanIn(a: AccountContext, cfg: AnalysisConfig): FindingDraft | null {
  const senders = new Set(a.inflows.map((e) => e.fromId));
  const total = a.inflows.reduce((s, e) => s + e.amountMinor, 0);
  if (senders.size < cfg.fanInMinSenders || total < cfg.fanInMinTotalMinor) return null;
  return {
    key: `FAN_IN:${a.id}`,
    motif: "FAN_IN",
    accountIds: [a.id],
    txnIds: a.inflows.map((e) => e.txnId),
    points: Math.min(25, senders.size * 3),
    features: { senders: senders.size, totalMinor: total },
    explanation: `received ${minorToInr(total)} from ${senders.size} different senders`,
  };
}

function firstTracedInTs(a: AccountContext): number | null {
  const traced = new Set(a.tracedInTxnIds);
  const t = a.inflows.filter((e) => traced.has(e.txnId)).sort(byTime)[0];
  return t ? t.ts : null;
}

/**
 * Rapid pass-through: after the first traced receipt of X, how long until the
 * account had sent onward ≥ passThroughMinRatio·X? Fast (≤ velocityMaxDwellMs)
 * → finding. Measured against the first traced receipt, so a later inflow
 * (e.g. a cycle returning money) cannot mask a fast pass-through. Sanity cap:
 * onward volume in the window may not exceed passThroughMaxRatio × inflow in
 * the window (an account spending a large pre-existing balance is not a
 * pass-through of the traced funds).
 */
function velocity(a: AccountContext, cfg: AnalysisConfig): FindingDraft | null {
  const traced = new Set(a.tracedInTxnIds);
  const firstIn = a.inflows.filter((e) => traced.has(e.txnId)).sort(byTime)[0];
  if (!firstIn) return null;
  const after = (e: LedgerEdge) => e.ts > firstIn.ts || (e.ts === firstIn.ts && e.seq > firstIn.seq);
  const horizon = firstIn.ts + cfg.velocityMaxDwellMs;
  const outs = a.outflows.filter((e) => after(e) && e.ts <= horizon).sort(byTime);
  const insInWindow = a.inflows.filter((e) => e.ts >= firstIn.ts && e.ts <= horizon).reduce((s, e) => s + e.amountMinor, 0);
  if (!outs.length) return null;
  const target = cfg.passThroughMinRatio * firstIn.amountMinor;
  let cum = 0;
  let reachedAt: LedgerEdge | null = null;
  const used: LedgerEdge[] = [];
  for (const o of outs) {
    cum += o.amountMinor;
    used.push(o);
    if (cum >= target) {
      reachedAt = o;
      break;
    }
  }
  if (!reachedAt) return null;
  const outTotal = outs.reduce((s, e) => s + e.amountMinor, 0);
  if (outTotal > cfg.passThroughMaxRatio * insInWindow) return null;
  const dwell = reachedAt.ts - firstIn.ts;
  const points = Math.round(35 - 15 * (dwell / cfg.velocityMaxDwellMs));
  const ratio = Math.round((cum / firstIn.amountMinor) * 100);
  return {
    key: `VELOCITY:${a.id}`,
    motif: "VELOCITY",
    accountIds: [a.id],
    txnIds: [firstIn.txnId, ...used.map((e) => e.txnId)],
    points,
    features: { dwellSec: Math.round(dwell / 1000), passThroughPct: ratio, receivedMinor: firstIn.amountMinor },
    explanation: `sent onward ${ratio}% of a ${minorToInr(firstIn.amountMinor)} traced receipt within ${Math.max(1, Math.round(dwell / 1000))} s`,
  };
}

function structuring(a: AccountContext, cfg: AnalysisConfig): FindingDraft | null {
  const hits = [...a.inflows, ...a.outflows].filter((e) => e.amountMinor >= cfg.structuringLowMinor && e.amountMinor < cfg.structuringHighMinor);
  if (hits.length < cfg.structuringMinCount) return null;
  return {
    key: `STRUCTURING:${a.id}`,
    motif: "STRUCTURING",
    accountIds: [a.id],
    txnIds: hits.map((e) => e.txnId),
    points: Math.min(20, hits.length * 4),
    features: { count: hits.length },
    explanation: `${hits.length} transfers just under ₹10,000`,
  };
}

function cashOut(a: AccountContext, cfg: AnalysisConfig): FindingDraft | null {
  const outs = a.outflows.filter((e) => a.sinkIds.has(e.toId));
  if (outs.length < cfg.cashOutMinCount) return null;
  const total = outs.reduce((s, e) => s + e.amountMinor, 0);
  return {
    key: `CASH_OUT:${a.id}`,
    motif: "CASH_OUT",
    accountIds: [a.id],
    txnIds: outs.map((e) => e.txnId),
    points: 10,
    features: { withdrawals: outs.length, totalMinor: total },
    explanation: `${outs.length} cash-out withdrawals totalling ${minorToInr(total)}`,
  };
}

/** Existing live-window heuristics, reused as an informational cross-check (0 points). */
function liveCrossCheck(a: AccountContext, now: number): { score: number; reasons: string[] } {
  const w: AccountWindow = {
    id: a.id,
    inflow: a.inflows.map((e) => ({ ts: e.ts, amount: minorToLegacyRupees(e.amountMinor), peer: e.fromId })),
    outflow: a.outflows.map((e) => ({ ts: e.ts, amount: minorToLegacyRupees(e.amountMinor), peer: e.toId })),
    lastTouched: now,
  };
  return scoreAccount(w, { id: a.id, vpa: a.id, name: a.id, createdAt: a.createdAt, kind: a.kind }, now);
}

export function analyzeCase(input: AnalysisInput): AnalysisOutput {
  const cfg = input.config;
  const findings = new Map<string, FindingDraft>();
  const perAccount = new Map<string, FindingDraft[]>();
  const add = (f: FindingDraft | null) => {
    if (!f) return;
    findings.set(f.key, f);
    for (const id of f.accountIds) perAccount.set(id, [...(perAccount.get(id) ?? []), f]);
  };

  const scorable = input.accounts.filter((a) => a.role === "TRACED");
  const traced = new Set(scorable.map((a) => a.id));
  for (const a of scorable) {
    add(fanOut(a, cfg));
    add(fanIn(a, cfg));
    add(velocity(a, cfg));
    add(structuring(a, cfg));
    add(cashOut(a, cfg));
  }
  // chronological cycles from the trace (already time-respecting)
  input.cycles.forEach((c, i) => {
    const members = [...new Set(c.nodeIds)].filter((id) => traced.has(id));
    if (members.length < 2) return;
    add({
      key: `CIRCULAR:${i}:${c.txnIds.join(",")}`,
      motif: "CIRCULAR",
      accountIds: members,
      txnIds: c.txnIds,
      points: 30,
      features: { cycleLength: c.txnIds.length },
      explanation: `funds returned along a ${c.txnIds.length}-hop chronological cycle ${c.nodeIds.join(" → ")}`,
    });
  });

  const candidates: CandidateDraft[] = input.accounts.map((a) => {
    const fs = (perAccount.get(a.id) ?? []).sort((x, y) => y.points - x.points);
    // one CIRCULAR contribution per account even if it sits on several cycles
    const seen = new Set<FindingMotif>();
    const contributions: Contribution[] = [];
    for (const f of fs) {
      if (seen.has(f.motif)) continue;
      seen.add(f.motif);
      contributions.push({ feature: f.motif, points: f.points, note: f.explanation });
    }
    const behavioural = contributions.some((c) => BEHAVIOURAL.includes(c.feature as FindingMotif));
    const ageDays = (input.now - a.createdAt) / 86_400_000;
    if (behavioural && ageDays < cfg.newAccountDays) {
      contributions.push({ feature: "NEW_ACCOUNT", points: 10, note: `account opened ${ageDays < 1 ? "<1" : Math.round(ageDays)} day(s) ago` });
    }
    contributions.push({ feature: "REACHABILITY", points: 0, note: "received downstream transfers in this trace (context only — not evidence by itself)" });
    const live = liveCrossCheck(a, input.now);
    contributions.push({ feature: "LIVE_HEURISTIC_CROSSCHECK", points: 0, note: `live-window detector score ${live.score}/100 (informational)` });

    const riskScore = Math.min(100, contributions.reduce((s, c) => s + c.points, 0));
    let exclusion: Exclusion = null;
    if (a.role === "VICTIM") exclusion = "CASE_VICTIM";
    else if (a.role === "MERCHANT" || a.role === "SINK") exclusion = "MERCHANT_OR_SINK";
    else if (!behavioural) exclusion = "NO_BEHAVIOURAL_EVIDENCE";
    else if (riskScore < cfg.suspectThreshold) exclusion = "BELOW_THRESHOLD";
    else if (a.victimInOtherCases.length) exclusion = "ROLE_CONFLICT";
    // victim/merchant/sink are never scored as mules in this case
    const scoredRole = a.role === "TRACED";
    const suspectedMule = scoredRole && behavioural && riskScore >= cfg.suspectThreshold;
    return {
      accountId: a.id,
      role: a.role,
      riskScore: scoredRole ? riskScore : 0,
      contributions: scoredRole ? contributions : [{ feature: "EXCLUDED", points: 0, note: exclusionNote(exclusion) }],
      suspectedMule,
      eligible: suspectedMule && exclusion === null,
      exclusion,
      features: { ageDays: Math.round(ageDays * 10) / 10, inflows: a.inflows.length, outflows: a.outflows.length, liveScore: live.score },
      findingKeys: scoredRole ? fs.map((f) => f.key) : [],
    };
  });
  candidates.sort((x, y) => y.riskScore - x.riskScore || x.accountId.localeCompare(y.accountId));
  return { findings: [...findings.values()], candidates };
}

export function exclusionNote(e: Exclusion): string {
  switch (e) {
    case "CASE_VICTIM":
      return "case victim — excluded from mule classification and automatic action";
    case "MERCHANT_OR_SINK":
      return "merchant / cash-out sink — not eligible";
    case "ROLE_CONFLICT":
      return "is the victim in another open case — manual review required";
    case "NO_BEHAVIOURAL_EVIDENCE":
      return "no behavioural finding — reachability alone is not evidence";
    case "BELOW_THRESHOLD":
      return "risk score below the suspect threshold";
    default:
      return "";
  }
}
