# Stable releases

1. Update the stable version in package.json and package-lock.json, current installation guide
   and docs/releases/<version>.md. Do not change native-tools.lock.json as part of an unrelated
   release; tool upgrades have their own reviewed change.
2. Review the PR and merge into main. CI, Browser integration and Windows verify run on main.
3. Completion of Windows verify triggers Release. Publication requires all three successful
   push runs for the exact same current main SHA; a PR run or an older successful run is rejected.
4. Release downloads the Windows bundle from that Browser integration run. It validates the
   source SHA/tree, pinned tools, extension version, exact file list, every SHA-256 and updater
   SHA-512/size before creating the version tag at that commit.
5. Assets are uploaded to a draft and their GitHub digests are checked before it is published as
   the latest stable release. The installer is not rebuilt. Existing published releases/tags are
   never overwritten. A retry can finish a matching incomplete draft safely.

The bundle contains the NSIS installer, blockmap, latest.yml, SHA256SUMS.txt, release-manifest.json,
Hebrew guide, engine lock and third-party notices. release-proof.json records the checks and
asset digests. The app uses the published latest.yml for ordinary updates.

The workflow needs only its built-in contents-write/actions-read GITHUB_TOKEN. It does not need a
personal token, system Node/Python on users' PCs, store publication or new signing credentials.
The installer remains unsigned. Direct npm run release also enforces the Actions/checks gate.
To retry publication, rerun the failed Release job or dispatch Release on main after all checks
pass. If main has changed, verify that new commit first; do not move an existing version tag.

The cleanup job retires only the four explicitly named integrated branches after publication.
Every deletion requires ancestry in main and an exact remote-head lease. Changed/unmerged
branches are preserved. This list is a one-time retirement list, not a rule for future branches.

Current architecture and owner scope: [architecture](architecture.md), [handoff](handoff.md),
[AGENTS](../AGENTS.md). Old candidates/audits are retained in [archive](archive/).
