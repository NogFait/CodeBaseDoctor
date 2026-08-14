import { Module } from "@nestjs/common";

// Placeholder for Phase 1. Real provider lands in Phase 3:
//   { provide: REPO_SOURCE_PORT, useClass: ShallowCloneAdapter }
// (depends on DockerRuntimeService). See design: "NestJS Wiring" - libs/repo-source.
@Module({})
export class RepoSourceModule {}
