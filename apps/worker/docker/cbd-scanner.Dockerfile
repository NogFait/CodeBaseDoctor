# cbd-scanner - network-isolated, read-only-mount container.
#
# Contents: semgrep, osv-scanner, git (metadata only - `ls-tree`/`log`, never
# `clone`/`fetch`), and a small Node indexer that computes LOC/language mix,
# invokes semgrep + osv-scanner, and emits one JSON blob (files + findings) on
# stdout. RepoContext is built from that blob in the worker process; analyzers
# never touch the filesystem directly. The indexer does NOT write
# `.cbd/scan-findings.json` onto the mounted tree — the volume is mounted
# `:ro`, so it physically can't. Instead `ShallowCloneAdapter.buildRepoContext()`
# special-cases that well-known path and synthesizes the JSON in-memory from
# this SAME stdout blob's `findings` field, so SecurityAnalyzer's
# ScanOutputReader seam (libs/analyzers/src/scan-output.ts) can still read it
# via the ordinary RepoContext.readFile() call. See
# libs/repo-source/src/shallow-clone-adapter.ts's readFile() doc comment for
# the full reasoning.
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
#
# --- Task 3.2.8: real offline Semgrep + OSV-Scanner invocation -------------
#
# The scanner runs with --network none at SCAN time (isolation requirement -
# the container reading untrusted repo content must have no socket at all).
# Neither tool's typical usage works network-free out of the box:
#   - Semgrep's `--config auto`/`p/ci` fetches rules from Semgrep's registry.
#   - OSV-Scanner's default vulnerability lookup queries the OSV.dev API.
# Both are made offline-capable by doing the network-dependent part at BUILD
# time (this Dockerfile's build stages DO have network) and baking the
# result into the image:
#   - Semgrep: a small, curated, vendored local rule file
#     (semgrep-rules/security.yaml — hardcoded secrets, eval/exec, SQL string
#     concatenation) is COPYed into the image and invoked with
#     `--config /opt/semgrep-rules` at scan time. This sidesteps
#     registry-fetch entirely rather than trying to cache the dynamic
#     registry. Deliberately NOT a full registry mirror — 3 high-signal
#     rules is enough for an honest MVP signal, per task scope.
#   - OSV-Scanner 1.9.1 ships `--experimental-download-offline-databases`
#     (fetch a full per-ecosystem vulnerability DB once) and
#     `--experimental-offline-vulnerabilities` (match against whatever DB is
#     already on disk, zero network). Verified directly in this sandbox:
#     `osv-scanner scan --experimental-download-offline-databases
#     --experimental-offline-vulnerabilities <dir>` downloads
#     `$TMPDIR/osv-scanner/<Ecosystem>/all.zip` (npm ~209MB, PyPI ~32MB, this
#     sandbox's actual measured sizes) and a SECOND run with only
#     `--experimental-offline-vulnerabilities` under `--network none`
#     correctly serves matches from that cached DB with no network call —
#     and correctly reports "could not find local databases" instead of
#     silently succeeding when the DB is absent, so a broken bake fails
#     loudly rather than faking a clean scan. Curated to 2 ecosystems this
#     project's own fixtures use (npm for TypeScript/JavaScript, PyPI for
#     Python) — full registry coverage (Go, Rust, Java, Ruby, ...) is out of
#     scope for this MVP pass; each additional ecosystem is another
#     multi-hundred-MB layer for a benefit this task doesn't need yet.
#     `--tmpfs /tmp` is a FRESH, empty filesystem on every container start
#     (same tmpfs-doesn't-persist lesson already learned for the fetcher/
#     scanner clone volume in Phase 3 batch A) — so the baked DB lives at a
#     permanent path (`/opt/osv-db`) and the indexer copies it into
#     `/tmp/osv-scanner` at the start of every scan, before invoking
#     osv-scanner.

FROM python:3.12-alpine3.20 AS semgrep-stage
# Pinned to alpine3.20 specifically (NOT the floating `python:3.12-alpine`
# tag) to match the runtime stage's `alpine:3.20` base exactly. Discovered
# directly in this sandbox: the floating tag currently resolves to Alpine
# 3.24, and a venv's compiled C-extensions built against Alpine 3.24's musl
# libc are not guaranteed ABI-compatible with Alpine 3.20's musl at runtime -
# pinning removes that risk entirely rather than hoping it never bites.
#
# `setuptools<81` pinned BEFORE installing semgrep: setuptools >=81 dropped
# the bundled `pkg_resources` shim, which one of semgrep's transitive
# dependencies (opentelemetry-instrumentation, imported via
# semgrep.tracing -> semgrep.app.auth) still imports unconditionally at
# module load time. Without this pin, `semgrep --help` itself crashes with
# `ModuleNotFoundError: No module named 'pkg_resources'` before ever reaching
# rule invocation — verified directly, this is a real, independent bug from
# the alpine-version ABI issue above, not a guess.
RUN python3 -m venv /opt/semgrep-venv \
    && /opt/semgrep-venv/bin/pip install --no-cache-dir 'setuptools<81' \
    && /opt/semgrep-venv/bin/pip install --no-cache-dir semgrep==1.87.0

FROM golang:1.23-alpine AS osv-scanner-stage
RUN go install github.com/google/osv-scanner/cmd/osv-scanner@v1.9.1

FROM osv-scanner-stage AS osv-db-stage
# Seed manifests exist ONLY to make osv-scanner detect the npm and PyPI
# ecosystems so `--experimental-download-offline-databases` fetches each
# ecosystem's FULL vulnerability database (not just entries for these two
# specific packages) — the seed packages themselves are irrelevant to what
# gets matched later against a real repo's real lockfiles.
#
# `XDG_CACHE_HOME` pinned explicitly: osv-scanner resolves its offline-DB
# cache dir via Go's `os.UserCacheDir()` (honors `$XDG_CACHE_HOME`, else
# `$HOME/.cache`) and only falls back to `$TMPDIR/osv-scanner` if THAT
# resolution fails outright (no HOME, no XDG_CACHE_HOME at all) — verified
# directly: this stage's base image has `HOME=/root` set by default, so
# without this override the DB silently lands in `/root/.cache/osv-scanner`
# instead of the path this Dockerfile expects, and the build fails one step
# later trying to `cp` from the wrong place. Pinning removes the ambiguity
# instead of depending on a base image's implicit default.
ENV XDG_CACHE_HOME=/cache
WORKDIR /osv-db-seed
RUN mkdir -p npm pypi \
    && printf '{"name":"seed","version":"1.0.0","lockfileVersion":2,"requires":true,"packages":{"":{"name":"seed","version":"1.0.0"},"node_modules/lodash":{"version":"4.17.15"}},"dependencies":{"lodash":{"version":"4.17.15"}}}' > npm/package-lock.json \
    && printf 'django==1.11.1\n' > pypi/requirements.txt \
    && ( /go/bin/osv-scanner scan --recursive --experimental-download-offline-databases --experimental-offline-vulnerabilities --format json /osv-db-seed > /dev/null || true ) \
    && mkdir -p /opt/osv-db \
    && cp -r /cache/osv-scanner/. /opt/osv-db/

FROM node:20-alpine AS indexer-stage
WORKDIR /indexer
COPY indexer/package.json indexer/package-lock.json* ./
# Indexer has zero runtime dependencies (stdlib fs/path only) - see
# indexer/package.json - so there is nothing to fetch here.
COPY indexer/index.js ./index.js

FROM alpine:3.20 AS runtime

RUN apk add --no-cache git=~2.45 python3~=3.12 nodejs~=20
# The venv COPYed in below was built by `python:3.12-alpine3.20`'s python3
# binary, which lives at /usr/local/bin/python3 in that official image (it
# builds Python from source under /usr/local). This Alpine runtime stage's
# apk-installed python3 lands at /usr/bin/python3 instead — verified
# directly: without this symlink, every venv script's `#!/opt/semgrep-venv/
# bin/python3 -> /usr/local/bin/python3` shebang resolves to a path that
# doesn't exist here, and `semgrep` (and every other venv entry point)
# fails with a bare "not found" (exit 127) that gives no hint it's an
# interpreter-path problem, not a missing-binary one. Pinning the alpine
# version above (3.20 to match) fixes venv ABI compatibility; this symlink
# is a SEPARATE, independently-required fix for the path itself.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python3

COPY --from=semgrep-stage /opt/semgrep-venv /opt/semgrep-venv
COPY --from=osv-scanner-stage /go/bin/osv-scanner /usr/local/bin/osv-scanner
COPY --from=osv-db-stage /opt/osv-db /opt/osv-db
COPY --from=indexer-stage /indexer /opt/indexer
COPY semgrep-rules /opt/semgrep-rules

ENV PATH="/opt/semgrep-venv/bin:${PATH}"
# osv-scanner resolves its offline-DB cache dir via `os.UserCacheDir()`
# (`$XDG_CACHE_HOME`, else `$HOME/.cache`) — pinned explicitly here for the
# SAME reason as the osv-db-stage build step above: without it, the
# resolved path depends on whatever HOME happens to default to for UID
# 65534 (verified directly: unset entirely, which is why the FIRST version
# of this fix fell back to osv-scanner's OWN internal `$TMPDIR/osv-scanner`
# default — that fallback exists but relying on an undocumented fallback
# instead of pinning the real flag was the wrong call once XDG_CACHE_HOME's
# behavior was understood). `/tmp` is the writable tmpfs mounted at scan
# time (`--tmpfs /tmp:size=256m`) — a FRESH, empty filesystem on every
# container start (same lesson already learned for the fetcher/scanner
# clone volume in Phase 3 batch A) — so the indexer copies the baked
# `/opt/osv-db` into `${XDG_CACHE_HOME}/osv-scanner` at the start of every
# scan, before invoking osv-scanner. See indexer/index.js runOsvScanner().
ENV HOME=/tmp
ENV XDG_CACHE_HOME=/tmp

# Ownership: 65534 (nobody) needs read access to the vendored rules and the
# baked OSV DB (it only ever COPIES the DB into the writable /tmp tmpfs, it
# never writes to /opt).
RUN chown -R 65534:65534 /opt/semgrep-rules /opt/osv-db

USER 65534:65534

WORKDIR /work

ENTRYPOINT ["node", "/opt/indexer/index.js"]
