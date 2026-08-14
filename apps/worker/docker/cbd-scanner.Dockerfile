# cbd-scanner - network-isolated, read-only-mount container.
#
# Contents: semgrep, osv-scanner, git (metadata only - `ls-tree`/`log`, never
# `clone`/`fetch`), and a small Node indexer that computes LOC/language mix
# and emits one JSON blob on stdout. RepoContext is built from that blob in
# the worker process; analyzers never touch the filesystem directly.
#
# Runtime flags (see design "Ephemeral Scan Container Design"), applied by
# ShallowCloneAdapter via dockerode when running this image - NOT baked into
# the image itself:
#   --network none --read-only  (volume mounted :ro at /work)
#   --tmpfs /tmp:size=256m --cap-drop ALL --security-opt no-new-privileges
#   --user 65534:65534 --memory 2g --pids-limit 512 --cpus 2
#
# No install step exists here - enforced by scripts/check-no-install-step.sh.
# All tool installation happens in earlier, disposable build stages; nothing
# resembling an installer is present in the runtime image or its layers.

FROM python:3.12-alpine AS semgrep-stage
RUN python3 -m venv /opt/semgrep-venv \
    && /opt/semgrep-venv/bin/python3 -m pip install --no-cache-dir semgrep==1.87.0

FROM golang:1.23-alpine AS osv-scanner-stage
RUN go install github.com/google/osv-scanner/cmd/osv-scanner@v1.9.1

FROM node:20-alpine AS indexer-stage
WORKDIR /indexer
COPY indexer/package.json indexer/package-lock.json* ./
# Indexer has zero runtime dependencies (stdlib fs/path only) - see
# indexer/package.json - so there is nothing to fetch here.
COPY indexer/index.js ./index.js

FROM alpine:3.20 AS runtime

RUN apk add --no-cache git=~2.45 python3~=3.12 nodejs~=20

COPY --from=semgrep-stage /opt/semgrep-venv /opt/semgrep-venv
COPY --from=osv-scanner-stage /go/bin/osv-scanner /usr/local/bin/osv-scanner
COPY --from=indexer-stage /indexer /opt/indexer

ENV PATH="/opt/semgrep-venv/bin:${PATH}"

USER 65534:65534

WORKDIR /work

ENTRYPOINT ["node", "/opt/indexer/index.js"]
