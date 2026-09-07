/**
 * Canonical UUID-shape guard, shared by the Prisma-backed repositories in
 * this package (PrismaScoreRepository.findById,
 * AnalysisJobRepository.findById). The `id` columns are `@db.Uuid`, so
 * Postgres rejects a non-UUID string as a hard query error, not a "no rows"
 * result — guarding with this pattern before querying lets a malformed id
 * be treated as "not found", matching the softer Map-like semantics the
 * shared contract suites expect ("returns null for an unknown id" passes a
 * non-UUID string).
 *
 * Previously duplicated verbatim in both repository modules; extracted here
 * so there is a single definition to keep correct.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
