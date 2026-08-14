# cbd-fetcher - network-enabled, clone-only container.
#
# Contents: alpine + git ONLY. No shell tooling beyond what alpine ships, no
# package managers, nothing that could interpret cloned repo content. This is
# the only one of the two ingestion containers with a network - the process
# that eventually reads untrusted repo bytes (cbd-scanner) has none.
#
# Runtime flags (see design "Ephemeral Scan Container Design"), applied by
# ShallowCloneAdapter via dockerode when running this image - NOT baked into
# the image itself:
#   --network bridge --read-only --tmpfs /tmp:size=64m --cap-drop ALL
#   --security-opt no-new-privileges --user 65534:65534 --memory 512m
#   --pids-limit 128 --cpus 1
#   volume mounted rw at /work
#
# No install step exists here - enforced by scripts/check-no-install-step.sh.

FROM alpine:3.20

RUN apk add --no-cache git=~2.45

# git config applied per-invocation by the adapter (not baked in), matching
# design step 2:
#   git -c core.hooksPath=/dev/null -c protocol.file.allow=never clone \
#     --depth 1 --single-branch --filter=blob:limit=1m --no-tags <url> /work
# with GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false
ENV GIT_CONFIG_NOSYSTEM=1 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/bin/false

# Runs as an unprivileged, non-root numeric UID at container start
# (--user 65534:65534 is passed at `docker run` time by dockerode; USER here
# is a defense-in-depth default in case flags are ever omitted).
USER 65534:65534

WORKDIR /work

ENTRYPOINT ["git"]
