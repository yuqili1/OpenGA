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

The queue includes every labeled textbook entry in the imported chapters.
Entries without a matching Lean file remain visible as textbook-only tasks:
their mathematical review can be completed, while `formal_review` stays
pending until a formalization is paired.

Lean source files are read from the git ref recorded in the tasks, currently
`origin/import/smooth-manifolds-lee`. In a contributor fork where that ref is
available on the `upstream` remote instead, the review tooling automatically
tries `upstream/import/smooth-manifolds-lee`. Fetch it with:

```bash
git fetch upstream import/smooth-manifolds-lee
```

An explicitly configured `SMOOTH_MANIFOLDS_LEE_IMPORT_REF` must name an existing
ref and is not replaced by the automatic remote fallback.
