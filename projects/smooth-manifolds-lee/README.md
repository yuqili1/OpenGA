# Smooth Manifolds Lee Review Data

This project contains the review queue for the Lean formalization of Lee's
`Introduction to Smooth Manifolds`.

The textbook source archive used by the review app is tracked at:

```text
projects/smooth-manifolds-lee/sources/smooth-manifolds.zip
```

The review app uses that archive by default. To test a different local archive,
set:

```bash
export SMOOTH_MANIFOLDS_LEE_ZIP=/path/to/smooth-manifolds.zip
```

The tracked archive is kept unchanged. Corrections from Lee's official errata
are applied by the review app and task generator from:

```text
projects/smooth-manifolds-lee/sources/errata/ism-2e.json
```

OpenGA review clarifications that are not Lee's text and are not official
errata are kept under separate provenance and applied from:

```text
projects/smooth-manifolds-lee/sources/clarifications/openga.json
```

Overlay documents declare either `official_errata` or
`openga_clarification`; official operations use `erratum_date`, while OpenGA
clarifications use `review_date`. This prevents a review clarification from
being presented as a correction issued by the author. For compatibility,
version-1 overlay documents without `source.kind` are treated as official
errata.

The queue includes every labeled textbook entry in the imported chapters.
Entries without a matching Lean file remain visible as textbook-only tasks:
their mathematical review can be completed, while `formal_review` stays
pending until a formalization is paired.

The evidence and limitations of the transitive `sorryAx` audit for tasks that
were marked `formal_review: done` are recorded at:

```text
projects/smooth-manifolds-lee/tasks/formal-audit.json
```

Import closure alone is not treated as proof that a task depends on `sorryAx`;
the report distinguishes confirmed declaration references from conservative
import-only candidates. The audit is pinned to the exact import commit, and
task generation fails if that ref moves until the audit is refreshed.

The current `formal_review: pending` queue is reproducibly classified by:

```bash
cd apps/review
npm run generate-lee-formal-triage
```

The generated report is tracked at:

```text
projects/smooth-manifolds-lee/tasks/formal-pending-triage.json
```

It separates textbook-only entries, direct `sorry` tokens, confirmed
transitive `sorryAx`, declaration-free `#check`/`recall` placeholders, and
items that still require semantic or dependency review. The report is pinned
to the same audited import commit.

The chapter-by-chapter human review of that queue is recorded separately at:

```text
projects/smooth-manifolds-lee/tasks/formal-pending-review.json
```

Human findings are non-exclusive: a task with a direct `sorry` may also have
a statement or coverage problem. All fifteen low-risk patch candidates have
compiled with the pinned Lean toolchain and passed declaration-level axioms
checks. Eight cover every direct `sorry` in their task, six intentionally cover
only selected declarations and retain fifteen explicit residual `sorry` tokens, and
one adds the missing half of a textbook statement; Proposition 5.2 also carries a
verified semantic-coverage repair. Exact source hashes, proofs,
toolchain metadata, and axioms results are recorded at:

```text
projects/smooth-manifolds-lee/tasks/formal-repair-validation.json
```

Here, “complete” refers only to direct-`sorry` coverage. The Proposition 5.2
patch now proves both existing holes and adds the textbook's uniqueness claim in
the representative-independent form that the identity between any two candidate
image structures is a diffeomorphism. The pinned source still lacks that theorem,
so the semantic finding remains tracked with `verified_patch` status until the
patch is applied.

The Theorem 4.12 patch closes four of five direct holes. Its submersion proof
constructs source coordinates from the centered target-chart expression and a
projection onto the derivative kernel, then applies the inverse function theorem;
its immersion proof normalizes mathlib's native complement coordinates. Both main
normal forms pass exact axioms checks independently of the remaining constant-rank
hole.

The Proposition 4.6 patch verifies composition and finite products of local
diffeomorphisms. Its remaining ambient extended-chart equivalence is false for
boundary models (the half-space identity extends normally as `t ↦ max t 0`),
and the open-submanifold restriction is still only represented by an
`isLocalDiffeomorphOn` name check. Both issues remain explicit semantic findings.

Theorem 4.29 also needs a statement correction before proof: Lee assumes its
source and target manifolds have no boundary, while the Lean version permits
arbitrary models with corners. Under that generalization a surjective map from
two half-lines to the real line gives a counterexample with `F(t) = |t|`.

The Theorem 4.15 patch closes both direct holes in its current boundary-immersion
statement. That statement uses mathlib's local-normal-form definition of
`Manifold.IsImmersion`. The attempted general equivalence with Lee's
differential-injectivity definition in `Definition_4_21_extra_1.lean` is false
for arbitrary targets with corners: a correctly restricted bridge, such as for
the boundaryless target used by Theorem 4.15, is still required.

The larger verified repairs are also preserved as replayable patches at:

```text
projects/smooth-manifolds-lee/tasks/patches/proposition-4-6-local-diffeomorphism-operations.patch
projects/smooth-manifolds-lee/tasks/patches/proposition-5-2-induced-image.patch
projects/smooth-manifolds-lee/tasks/patches/theorem-4-12-local-normal-forms.patch
projects/smooth-manifolds-lee/tasks/patches/theorem-4-15-boundary-immersion.patch
projects/smooth-manifolds-lee/tasks/patches/theorem-5-51-euclidean-half-slice.patch
```

These artifacts use zero-context hunks. The validator replays them with
`git apply --unidiff-zero` against source blobs from the pinned import commit.

Validation was performed in an isolated temporary copy. The imported Lean
source branch remains read-only during this review.

The direct-`sorry` repair investigation queue is regenerated by:

```bash
cd apps/review
npm run generate-lee-formal-repair-queue
```

and tracked at:

```text
projects/smooth-manifolds-lee/tasks/formal-repair-queue.json
```

Its ordering combines reviewed downstream signals, the textbook-reference
graph, direct source-module importers, placeholder volume, and low-risk patch
candidates. Reference edges and module imports are not presented as Lean
proof-dependency or `sorryAx` certification.

Lean source files are read from the git ref recorded in the tasks, currently
`origin/import/smooth-manifolds-lee`. In a contributor fork where that ref is
available on the `upstream` remote instead, the review tooling automatically
tries `upstream/import/smooth-manifolds-lee`. Fetch it with:

```bash
git fetch upstream import/smooth-manifolds-lee
```

An explicitly configured `SMOOTH_MANIFOLDS_LEE_IMPORT_REF` must name an existing
ref and is not replaced by the automatic remote fallback.
