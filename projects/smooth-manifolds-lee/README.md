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
a statement or coverage problem. All thirty-four low-risk candidates passed
declaration-level axioms checks with the pinned Lean and mathlib revisions.
Fourteen cover every direct `sorry` in their task, ten intentionally cover only
selected declarations and retain twenty-eight explicit residual `sorry` tokens,
and ten repair missing or mismatched statements and signatures without changing
a direct-`sorry` count. Exact module builds were used where the pinned cache was
available; every narrowed-import or dependency-interface harness is identified
as such in the validation report and is not presented as a clean full-project
build. Exact source hashes, proofs, toolchain metadata, and axioms results are
recorded at:

```text
projects/smooth-manifolds-lee/tasks/formal-repair-validation.json
```

The regularity audit distinguishes mathlib's analytic order `ω` from the
textbook's ordinary smooth order `∞`. Seventeen formerly completed tasks are
therefore pending again: their mathematics is generally sound, but their Lean
owners or downstream signatures are too strong, omit required topology or
finite-dimensional data, or remain coupled to an analytic owner. The tracked
signature candidates preserve this distinction instead of silently treating
`⊤` as a synonym for `∞`.

Problem 1.9 now has a verified second-countability candidate for complex
projective space. Problems 5.4 and 5.5 have verified owner-independent C∞
topological obstructions; their compatibility wrappers retain the pinned
analytic embedded-submanifold statements.

The Lemma 2.26 patch completes the supported smooth-extension theorem by
combining a normally shrunk neighborhood with a global smooth selection from
pointwise convex constraints. It passes the exact axioms check with no residual
direct `sorry`.

The Proposition 3.2 patch closes thirteen of fifteen direct holes in the
identification of geometric tangent vectors with point derivations on
Euclidean space. The remaining right-inverse direction requires a smooth
Hadamard decomposition of an arbitrary smooth function; the dependent
linear-equivalence application is therefore also retained until that result is
available without `sorryAx`.

The Proposition 3.18 patch completes the smoothness proof for the tangent-bundle
projection by reusing mathlib's canonical vector-bundle projection theorem. The
`2n`-dimensional model remains represented structurally by `I.tangent`; this
task does not introduce a separate finrank theorem.

The Example 4.2 patch closes five of nine direct holes: the Euclidean head
projection and its submersion proof, the one-dimensional velocity criterion,
and two definitional torus formulas. Four larger projection/torus arguments
remain. The curve declaration is mathematically correct but covers only the
pointwise linear-algebra core of Lee's immersion criterion, not a complete
`Manifold.IsImmersion` statement for an interval manifold, so that coverage gap
remains explicit.

The Lemma 3.11 patch completes the half-space inclusion derivative result. The
model-map derivative is the identity continuous linear map at every half-space
point, so the theorem's boundary equation is an unused but harmless stronger
hypothesis; the exact axioms check is free of `sorryAx`.

Corollary 4.43 requires statement repair before a proof attempt. Lee's
finite-dimensional real theorem is correct, but the Lean declaration ranges
over arbitrary nontrivially normed fields and models with corners, and asks for
the covering type in an independent unconstrained universe. Mathlib supplies
lifting uniqueness but no general universal-cover existence construction; the
project's verified Proposition 4.40 can only add a smooth structure after a
topological cover has been supplied.

Proposition 5.38 is also correct in Lee's real finite-dimensional setting. Its
Lean version represents the local defining map by a global function and
generalizes the scalar field without the completeness assumptions required by
the available implicit-function machinery. The easy tangent-to-kernel
inclusion does not prove the reverse inclusion; that direction still needs a
regular-level-set theorem or equivalent dimension/local-normal-form result.

Proposition 4.1 mixes two notions: its derivative-based submersion half is
mathematically sound but still lacks clean openness and open-subtype derivative
bridges, while its immersion half targets mathlib's stronger local-normal-form
notion. For arbitrary corner models, injectivity of `mfderiv` alone is not an
acceptable bridge to that target; the statement needs a derivative-based
immersion notion or additional boundary compatibility.

Theorem 4.25 and Exercise 4.16 are mathematically standard, but both expose
unfinished local-normal-form infrastructure. Mathlib still marks the relevant
smooth-embedding/immersion composition and local restriction bridges as
`proof_wanted`; Exercise 4.16's remaining hole is specifically the construction
of a local straightening on `Set.range K`, not a small tactic gap.

Definition 1-extra-1 faithfully encodes Lee's topological-manifold convention,
but its dimension-uniqueness hole reduces to Brouwer invariance of dimension.
The reduction to a local homeomorphism between nonempty Euclidean open sets is
axiom-clean; the pinned mathlib has no general theorem closing the remaining
dimension step.

Proposition 1.19 currently uses `⊤ : WithTop ℕ∞`, which is the analytic
order `ω`, where the textbook requires the smooth order `∞`. An axiom-clean
proof of the corrected statement is feasible, but its chart-normalization
helpers should be moved out of the much later Problem 1.6 module before the
definition and its users are changed together.

Theorems 4.31 and 5.31 both need their Lean statements narrowed before proof.
The former drops Lee's finite-dimensional real assumptions, so a smooth linear
bijection between noncomplete normed models may have a nonsmooth inverse. The
latter does not require finite dimension, Hausdorffness, or second countability
of the alternative immersed structure, allowing a discrete zero-dimensional
structure on the same carrier. Both generalizations therefore admit
counterexamples; their textbook statements remain correct.

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

The Theorem 4.26 patch closes its elementary local-section equation helper, but
the main equivalence is false for arbitrary models with corners: the closed
half-line inclusion into the real line has surjective derivative at zero and no
local right inverse on an ambient neighborhood. The same example invalidates
Proposition 4.28's current open-map generalization.

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
projects/smooth-manifolds-lee/tasks/patches/example-4-2-basic-projections-and-formulas.patch
projects/smooth-manifolds-lee/tasks/patches/example-1-28-full-rank-matrices.patch
projects/smooth-manifolds-lee/tasks/patches/corollary-5-30-smooth-restriction.patch
projects/smooth-manifolds-lee/tasks/patches/definition-1-3-smooth-coordinate-balls.patch
projects/smooth-manifolds-lee/tasks/patches/definition-5-36-regular-domain-signature.patch
projects/smooth-manifolds-lee/tasks/patches/example-2-14-smooth-charts.patch
projects/smooth-manifolds-lee/tasks/patches/exercise-3-19-smooth-tangent-bundle.patch
projects/smooth-manifolds-lee/tasks/patches/lemma-2-26-smooth-extension.patch
projects/smooth-manifolds-lee/tasks/patches/lemma-3-11-boundary-tangent-model.patch
projects/smooth-manifolds-lee/tasks/patches/problem-1-9-second-countability.patch
projects/smooth-manifolds-lee/tasks/patches/problem-5-4-smooth-figure-eight-obstruction.patch
projects/smooth-manifolds-lee/tasks/patches/problem-5-5-smooth-dense-curve-obstruction.patch
projects/smooth-manifolds-lee/tasks/patches/proposition-2-15-diffeomorphism-basics.patch
projects/smooth-manifolds-lee/tasks/patches/proposition-3-18-tangent-bundle-projection.patch
projects/smooth-manifolds-lee/tasks/patches/proposition-3-2-geometric-derivations.patch
projects/smooth-manifolds-lee/tasks/patches/proposition-4-6-local-diffeomorphism-operations.patch
projects/smooth-manifolds-lee/tasks/patches/proposition-5-2-induced-image.patch
projects/smooth-manifolds-lee/tasks/patches/proposition-5-41-boundary-vector-exclusions.patch
projects/smooth-manifolds-lee/tasks/patches/theorem-4-12-local-normal-forms.patch
projects/smooth-manifolds-lee/tasks/patches/theorem-4-15-boundary-immersion.patch
projects/smooth-manifolds-lee/tasks/patches/theorem-4-26-local-section-apply.patch
projects/smooth-manifolds-lee/tasks/patches/theorem-5-27-smooth-domain-restriction.patch
projects/smooth-manifolds-lee/tasks/patches/theorem-5-51-euclidean-half-slice.patch
projects/smooth-manifolds-lee/tasks/patches/theorem-5-53-smooth-restrictions.patch
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
