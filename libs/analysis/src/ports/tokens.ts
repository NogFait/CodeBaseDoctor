// DI provider tokens for the five outbound ports of the analysis domain.
// See design: "Interfaces / Contracts > The five ports".
// One implementation of `CategoryAnalyzer` per category is provided as an
// array behind CATEGORY_ANALYZERS (multi-provider).

export const REPO_SOURCE_PORT = Symbol("RepoSourcePort");
export const LLM_JUDGE_PORT = Symbol("LLMJudgePort");
export const SCORE_REPOSITORY_PORT = Symbol("ScoreRepositoryPort");
export const USAGE_QUOTA_PORT = Symbol("UsageQuotaPort");
export const CATEGORY_ANALYZERS = Symbol("CategoryAnalyzer[]");
