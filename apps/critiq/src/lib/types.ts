/** Mirrors the shapes returned by the `critiq-review` Edge Function. */

export type Dimension =
  | 'crawlability'
  | 'metadata'
  | 'content'
  | 'structure'
  | 'links'
  | 'structured-data'
  | 'answer-engine'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface Finding {
  id: string
  source: 'check' | 'llm'
  dimension: Dimension
  severity: Severity
  title: string
  evidence: string
  fix: string
  code?: string
}

/** `overall` plus one letter per dimension. */
export type Grades = Record<string, string>

export interface ReviewResponse {
  slug: string
  url: string
  grades: Grades
  findings: Finding[]
  /** Ids of the checks that applied to this page and did not fire. */
  passed?: string[]
  cached: boolean
  judgeError?: string | null
}

export interface StoredReport {
  slug: string
  url: string
  status: string
  grades: Grades
  findings: Finding[]
  digest: Record<string, unknown> | null
  created_at: string
}

export interface ReportSummary {
  slug: string
  url: string
  grades: Grades | null
  created_at: string
}
