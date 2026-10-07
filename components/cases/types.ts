/** Shapes of the case API responses as the workspace consumes them. */
import type { AccountHold, AnalysisRun, Case, CandidateScore, EnforcementAction, Finding, TraceRun } from "@/lib/contracts/types";
import type { TraceSnapshot } from "@/lib/modules/tracing/job";
import type { CaseOutcomeView } from "@/lib/modules/outcomes/outcome";
import type { StepView } from "./Stepper";

export interface CaseViewData {
  case: Case;
  victim: { id: string; vpa: string; kind: string; balanceMinor: number | null };
  disputed: { txnId: string; amountMinor: number; ts: number; seq: number; to: { id: string; vpa: string; kind: string } | null }[];
  holds: (AccountHold & { account: { id: string; vpa: string; kind: string }; otherActiveHolds: number })[];
  traces: TraceRun[];
  analysis: AnalysisRun | null;
  actions: EnforcementAction[];
  steps: StepView[];
  audit: { id: string; actorId: string; action: string; detail: string; createdAt: number }[];
  reports: { id: string; contentHash: string; createdAt: number; actorId: string }[];
  policy: { autoDemoEnabled: boolean };
}

export interface TraceData {
  runs: TraceRun[];
  run: TraceRun | null;
  snapshot: TraceSnapshot | null;
}

export interface AnalysisData {
  run: AnalysisRun | null;
  latestRevision: number | null;
  findings: (Finding & { accountVpas: string[] })[];
  candidates: (CandidateScore & { vpa: string; victimMoneyMinor: number; caseHold: string | null; suspectedInOtherCases: string[] })[];
}

export type OutcomeData = CaseOutcomeView;
