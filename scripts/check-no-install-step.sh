#!/usr/bin/env bash
# Auditable enforcement of "never execute repo code" (design: "Ephemeral Scan
# Container Design"): neither ingestion Dockerfile may contain a step that
# installs or runs dependencies FROM the cloned repository. Both images
# install their OWN tooling (git, semgrep, osv-scanner, node) in Dockerfile
# build stages, which is fine and expected - what this script forbids is any
# RUN/CMD/ENTRYPOINT line that could execute a package-manager command
# against repo-supplied manifests (package.json, requirements.txt, Gemfile,
# go.mod, ...) at container runtime.
#
# Usage: scripts/check-no-install-step.sh
# Exit code: 0 if clean, 1 if a forbidden pattern is found.
#
# Deliberately grep-based (not a Dockerfile parser): the audit trail must be
# readable by anyone, not just tooling that understands Dockerfile syntax.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

DOCKERFILES=(
  "${REPO_ROOT}/apps/worker/docker/cbd-fetcher.Dockerfile"
  "${REPO_ROOT}/apps/worker/docker/cbd-scanner.Dockerfile"
)

# Package-manager invocations that must never appear as a RUN/CMD/ENTRYPOINT
# instruction in the image's FINAL (runtime) stage - i.e. what actually ships
# and could run against the mounted repo volume. Pattern per design
# "Ephemeral Scan Container Design": npm|yarn|pnpm|pip|bundle|go mod.
FORBIDDEN_PATTERN='(^|[^A-Za-z0-9_-])(npm|yarn|pnpm|pip|bundle|go mod)([^A-Za-z0-9_-]|$)'

status=0

for dockerfile in "${DOCKERFILES[@]}"; do
  if [[ ! -f "${dockerfile}" ]]; then
    echo "FAIL: ${dockerfile} not found" >&2
    status=1
    continue
  fi

  # Multi-stage builds (cbd-scanner) may legitimately use a package manager
  # in an EARLIER build stage to install the scanner's OWN tooling (e.g.
  # `pip install semgrep`, `go install osv-scanner`) - those stages have no
  # access to the per-job repo volume at build time and never run against
  # repo-supplied code. Only the LAST stage (what `docker run` actually
  # executes against the mounted volume) is audited here. Single-stage
  # Dockerfiles (cbd-fetcher) have exactly one stage, so this is a no-op
  # narrowing for them.
  last_stage_start="$(grep -n '^FROM ' "${dockerfile}" | tail -1 | cut -d: -f1)"
  last_stage="$(tail -n "+${last_stage_start}" "${dockerfile}")"

  matches="$(echo "${last_stage}" | grep -nE '^[[:space:]]*(RUN|CMD|ENTRYPOINT|SHELL)' \
    | grep -Ei "${FORBIDDEN_PATTERN}" || true)"

  if [[ -n "${matches}" ]]; then
    echo "FAIL: forbidden package-manager invocation in final stage of ${dockerfile}:" >&2
    echo "${matches}" >&2
    status=1
  fi
done

if [[ "${status}" -eq 0 ]]; then
  echo "OK: no install-step instructions found in ${#DOCKERFILES[@]} Dockerfile(s)."
fi

exit "${status}"
