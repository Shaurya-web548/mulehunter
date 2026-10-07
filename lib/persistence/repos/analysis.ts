import type { AnalysisRun, CandidateScore, Finding } from "../../contracts/types.ts";
import { stmt, type DBSync } from "./shared.ts";

export class AnalysisRepository {
  private db: DBSync;

  constructor(db: DBSync) {
    this.db = db;
  }

  nextRevision(caseId: string): number {
    const r = stmt(this.db, "SELECT COALESCE(MAX(revision), 0) AS v FROM case_analysis_runs WHERE case_id = ?").get(caseId);
    return Number(r?.v ?? 0) + 1;
  }

  insertRun(run: AnalysisRun, idempotencyKey: string | null): void {
    stmt(
      this.db,
      `INSERT INTO case_analysis_runs
       (case_id, revision, trace_revision, detector_version, config_version, config_json, idempotency_key, summary_json, created_at, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.caseId,
      run.revision,
      run.traceRevision,
      run.detectorVersion,
      run.configVersion,
      JSON.stringify(run.config),
      idempotencyKey,
      JSON.stringify(run.summary),
      run.createdAt,
      run.actorId,
    );
  }

  latestRun(caseId: string): AnalysisRun | null {
    const r = stmt(this.db, "SELECT * FROM case_analysis_runs WHERE case_id = ? ORDER BY revision DESC LIMIT 1").get(caseId);
    return r ? this.runRow(r) : null;
  }

  run(caseId: string, revision: number): AnalysisRun | null {
    const r = stmt(this.db, "SELECT * FROM case_analysis_runs WHERE case_id = ? AND revision = ?").get(caseId, revision);
    return r ? this.runRow(r) : null;
  }

  runByKey(caseId: string, key: string): AnalysisRun | null {
    const r = stmt(this.db, "SELECT * FROM case_analysis_runs WHERE case_id = ? AND idempotency_key = ?").get(caseId, key);
    return r ? this.runRow(r) : null;
  }

  insert(caseId: string, revision: number, findings: Finding[], candidates: CandidateScore[]): void {
    const st = stmt(
      this.db,
      `INSERT INTO case_findings
       (id, case_id, revision, motif, account_ids_json, txn_ids_json, score_minor, explanation, detector_version, config_version, created_at, features_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of findings) {
      st.run(
        f.id,
        caseId,
        revision,
        f.motif,
        JSON.stringify(f.accountIds),
        JSON.stringify(f.txnIds),
        f.points,
        f.explanation,
        f.detectorVersion,
        f.configVersion,
        f.createdAt,
        JSON.stringify(f.features),
      );
    }
    const sc = stmt(
      this.db,
      `INSERT INTO case_candidates
       (case_id, revision, account_id, score_minor, contributions_json, suspect_mule, role, eligible, exclusion, features_json, finding_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of candidates) {
      sc.run(
        caseId,
        revision,
        c.accountId,
        c.riskScore,
        JSON.stringify(c.contributions),
        c.suspectedMule ? 1 : 0,
        c.role,
        c.eligible ? 1 : 0,
        c.exclusion,
        JSON.stringify(c.features),
        JSON.stringify(c.findingIds),
      );
    }
  }

  listFindings(caseId: string, revision: number): Finding[] {
    return stmt(this.db, "SELECT * FROM case_findings WHERE case_id = ? AND revision = ? ORDER BY score_minor DESC, id")
      .all(caseId, revision)
      .map((r) => ({
        id: String(r.id),
        caseId: String(r.case_id),
        revision: Number(r.revision),
        motif: r.motif as Finding["motif"],
        accountIds: JSON.parse(String(r.account_ids_json)),
        txnIds: JSON.parse(String(r.txn_ids_json)),
        points: Number(r.score_minor),
        features: JSON.parse(String(r.features_json ?? "{}")),
        explanation: String(r.explanation),
        detectorVersion: String(r.detector_version),
        configVersion: String(r.config_version),
        createdAt: Number(r.created_at),
      }));
  }

  listCandidates(caseId: string, revision: number): CandidateScore[] {
    return stmt(this.db, "SELECT * FROM case_candidates WHERE case_id = ? AND revision = ? ORDER BY score_minor DESC, account_id")
      .all(caseId, revision)
      .map((r) => ({
        accountId: String(r.account_id),
        riskScore: Number(r.score_minor),
        contributions: JSON.parse(String(r.contributions_json)),
        suspectedMule: !!r.suspect_mule,
        role: String(r.role) as CandidateScore["role"],
        eligible: !!r.eligible,
        exclusion: r.exclusion == null ? null : String(r.exclusion),
        features: JSON.parse(String(r.features_json ?? "{}")),
        findingIds: JSON.parse(String(r.finding_ids_json ?? "[]")),
      }));
  }

  /** Cases in which this account was ever a suspected mule (cross-case view). */
  suspectedIn(accountId: string): string[] {
    return stmt(this.db, "SELECT DISTINCT case_id FROM case_candidates WHERE account_id = ? AND suspect_mule = 1")
      .all(accountId)
      .map((r) => String(r.case_id));
  }

  private runRow(r: Record<string, unknown>): AnalysisRun {
    return {
      caseId: String(r.case_id),
      revision: Number(r.revision),
      traceRevision: Number(r.trace_revision),
      detectorVersion: String(r.detector_version),
      configVersion: String(r.config_version),
      config: JSON.parse(String(r.config_json)),
      summary: JSON.parse(String(r.summary_json)),
      createdAt: Number(r.created_at),
      actorId: String(r.actor_id),
    };
  }
}
