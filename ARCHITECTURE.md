# Architecture

The current shape of this library, with the rationale inline: why each
part is shaped the way it is, stated where the shape is described.
This file is kept current in the same change set that alters the
shape; it overwrites in place and records no history. History lives
elsewhere: CHANGELOG.md for what landed, `decisions/` for durable
decisions with their rejected alternatives and revisit criteria, and
the archived roadmap for the work items. Reference decision records
from here where the resulting shape is described, instead of
re-arguing them.

Several conventions lean on this file, so keep it accurate and current:
the design gate defines a cross-cutting item as one touching an
invariant documented here, a `touches:` entry names this file as a
deliverable in its own right, and the breaking-release audit checks
its statements against the code.

This template copy is a skeleton. Replace the section bodies as the
library takes shape; keep the sections. Delete this paragraph and the
two above's template framing when scaffolding a real repo.

## Layer map

The module tour: what lives where, and the dependency direction
between the parts. One line per module or directory is enough while
the library is small.

```
src/index.ts        Public entry point (the export map's only door)
src/Example.ts      Example class (replace with real modules)
```

## Invariants

The rules the code upholds that a reader cannot infer from any one
call site, numbered so items and reviews can cite them. Each entry
states the rule, why it holds, and the code that upholds it. This
list is what the design gate's invariant inventory walks; an
undocumented invariant is unprotected by the gate.

1. (none yet)

## Ownership heuristics

Where a given kind of change goes: which module owns which concern,
and what does not belong in this repo at all (points at the owning
`@interop/*` package or spec instead). This is the section that stops
a shared concern from being reimplemented locally.

## Current State labels

Label structure that is aspirational as Desired Direction and areas
mid-migration as Transitional, in place, rather than describing the
intended end state as if it were current. A reader must be able to
tell what holds today from what is planned.
