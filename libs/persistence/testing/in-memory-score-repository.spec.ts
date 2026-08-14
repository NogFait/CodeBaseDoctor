import { InMemoryScoreRepository } from "./in-memory-score-repository";
import { describeScoreRepositoryContract } from "./score-repository.contract";

// Runs the shared ScoreRepositoryPort contract suite against the in-memory
// double. Phase 3 imports `describeScoreRepositoryContract` again to run the
// exact same suite against PrismaScoreRepository (Testcontainers Postgres)
// without duplicating assertions.
describeScoreRepositoryContract(() => new InMemoryScoreRepository());
