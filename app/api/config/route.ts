import { operatorCodeIsGenerated } from "@/lib/auth/session";
import { handle, ok } from "@/lib/http/api";
import { autoDemoEnabled } from "@/lib/modules/enforcement/freeze";
import { retentionMs } from "@/lib/modules/payments/retention";
import { DEFAULT_TRACE_CONFIG } from "@/lib/modules/tracing/trace";
import { DEFAULT_ANALYSIS_CONFIG, DETECTOR_VERSION } from "@/lib/modules/analysis/score";
import { baseTps } from "@/lib/runtime";

/** Public, non-secret runtime configuration for the console. */
export const GET = handle(async () =>
  ok({
    autoDemoEnabled: autoDemoEnabled(),
    operatorCodeGenerated: operatorCodeIsGenerated(),
    historyRetentionMin: Math.round(retentionMs() / 60_000),
    baseTps: baseTps(),
    trace: DEFAULT_TRACE_CONFIG,
    analysis: { detectorVersion: DETECTOR_VERSION, ...DEFAULT_ANALYSIS_CONFIG },
  }),
);
