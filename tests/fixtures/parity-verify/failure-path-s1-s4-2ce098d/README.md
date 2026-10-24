# Integrated S1 -> S4 synthetic failure captures

Current snapshot: commit 2ce098d4d7fb0af2e65de7a564b8846fef327a79, tree
17c4a53f08545c90f686756919e2df84ec49502a. Captured while this worktree was
clean. The 65-entry source closure equals both the working bytes and git blobs
of that commit. Records use the historical V1 path with unchanged fake
transports, clocks, private modes and five scenarios; these are synthetic data.

Historical failure-path/ records and metadata remain byte-identical. Only the
current import-closure check and final fresh-capture comparison point here,
under RULING-PROVENANCE-R2D-01 Option B and final-byte audit. Historical schema,
privacy, failure, mapping and storage checks and literal pins are retained.
The only comparison exclusions remain the three explicit run-ID paths.

Two independent Node processes called captureFailureFixtures(), followed by
fixtureSourceHashes(). Their records differ only at the fifteen existing
run-ID leaves. The first capture is installed here, with native parsed records
unmodified. Metadata baseCommit identifies the actual integrated source;
the historical generator CLI's inherited baseCommit3071720 was not used to
label this current capture. The generator source itself is unchanged.

Old -> final record differences: 41 leaves, comprising15 run IDs,25 instruction
source hashes and1 derived prompt-source manifest hash. No behavior, clock,
call/send, failure, policy, storage or schema difference was found. The source
map has20 changed/added leaves. Capture/commit/leaf evidence and the concrete
test-target diff are in the private R2-D review packet. Future fixture updates
require new explicit review; the historical snapshot is not overwritten.
Japanese quality: Argon未評価. No Japanese wording is revised here.
