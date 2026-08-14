import { Module } from "@nestjs/common";
import { REPO_SOURCE_PORT } from "@cbd/analysis";
import { ShallowCloneAdapter } from "./shallow-clone-adapter";

// See design: "NestJS Wiring" - libs/repo-source. ShallowCloneAdapter's own
// constructor lazily connects to the local Docker socket (dockerode does
// not eagerly dial on construction), so this provider is cheap to
// instantiate even in processes that never call materialize().
//
// `useFactory` rather than `useClass`: ShallowCloneAdapter's constructor
// takes a plain options interface (image names, an injectable Dockerode
// instance for tests), not a Nest-resolvable provider token — an
// interface type is erased at runtime, so Nest's reflection-based
// constructor injection would try to resolve a non-existent "Object"
// provider for it. A factory sidesteps that entirely.
@Module({
  providers: [{ provide: REPO_SOURCE_PORT, useFactory: () => new ShallowCloneAdapter() }],
  exports: [REPO_SOURCE_PORT],
})
export class RepoSourceModule {}
