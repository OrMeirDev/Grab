# ADR 0001: The main process owns the download queue

Date: 2026-10-14. Status: accepted (implemented on `claude/modest-pasteur-6315xe`). Findings: GRB-01, GRB-02, GRB-03.

## Context

The queue lived in React state: effects scheduled lookups and downloads, retried, tracked site
blocks and wrote history after the renderer saw success. The main process trusted whatever job the
renderer sent (folder, lookup file, cookie handle). Consequences: the YouTube rest timer could
leave the next job queued forever (GRB-01, reproduced); a window reload or renderer crash lost the
queue while yt-dlp kept running; history depended on the renderer surviving; and the renderer
could ask for arbitrary files and session material (GRB-03).

## Decision

A `DownloadCoordinator` in the main process (application layer) owns all job state and
transitions. The renderer sends commands that name jobs by id and renders numbered snapshots.
Clock, randomness, discovery, download runner, storage and history are injected, so scheduling is
tested with a fake clock. Patterns: ports and adapters around yt-dlp, the probes, the browser
session and storage; feature-based React for presentation. No global UI store, no SQLite (atomic
JSON is enough at this scale), no cloud or extra processes. Download concurrency stays 1.

## Consequences

- Reload-safe and restart-safe queue (restored downloads come back paused); history is
  authoritative; secrets never reach the renderer.
- The renderer has no scheduling code left; its tests are visual (pixel comparison) and e2e.
- e2e checks that seeded rows through React internals use the coordinator's `seed` test seam.
- Behavior changes accepted with it: "download all" no longer lifts other sites' blocks (GRB-14),
  and the queue reappears after a restart.

## Alternatives considered

Keep the queue in React and only fix the effect dependency (done first as a minimal, separate fix
for GRB-01, but it leaves GRB-02/03); a separate worker process (adds IPC and lifecycle without a
present need).
