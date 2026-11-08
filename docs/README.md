# cortextOS Engineering Knowledge Base

## Provenance

### Verified in this session

- `.gitignore:46-47` ignores local operations documents by default; `.gitignore:71-81` narrowly allowlists the portable operating guide and its four adapter notes.

### Reported by another verified source

- No external or agent-reported engineering facts are included on this index page.

### Inference

- This page serves as a navigation and governance index; technical details belong in the linked references.

### Open assumptions

- The document categories below reflect the current local repository layout and may change as the documentation structure evolves.

Engineering memory for the product. Everything here exists so another engineer — or a
future AI — can build cortextOS correctly.

## What belongs here

```
docs/
  architecture/    Architecture Decision Records (ADRs)
  reviews/         Engineering reviews and external audits
  design/          Design documents for systems not yet built
  specs/           Interface and API specifications
  phase-reports/   Historical phase validation reports
```

Every document here must be version controlled, reviewed, commit-linked, and reproducible.

## What does NOT belong here

No customer information. No business operations. No private executive notes.

Those live in the Obsidian vault, which is the system of record for operational history:
executive session logs, business command centers, automation roadmaps, company playbooks,
client command centers, property management, investor relations, daily logs, meeting notes.

The split exists because cortextOS is being productized for other clients. Business detail
must not ship inside the product repository.

## Provenance standard

Every engineering document in this tree opens with a Provenance section:

```markdown
## Provenance

### Verified in this session
Claims checked directly against source, with file:line citations.

### Reported by another verified source
Claims relayed from another session, agent, or person. Name the source.

### Inference
Conclusions drawn from the above rather than observed directly.

### Open assumptions
What must be true for this document to hold, and has not been confirmed.
```

This section is not optional. It exists to prevent the specific failure where something
said in conversation becomes treated as fact without anyone noticing.

Executive session logs in Obsidian follow a weaker bar by design: they may summarize work
across multiple coordinated sessions, but must identify the source of each non-local claim.
Their job is operational history, not engineering proof.

## Decision authority

The Decision Registry is authoritative for whether a decision is Approved, Active,
Deprecated, or Superseded. ADRs in `architecture/` hold the reasoning and detail; they do
not hold status. When the two disagree, the registry wins.

## Note on version control

`.gitignore:46-47` ignores local `docs/` files by default. The narrow allow-list at `.gitignore:71-81` makes the documentation index, provider-neutral operating guide, and four provider adapter notes trackable; other local operations documents remain ignored by default.

## Portable agent operating guide

The platform-neutral CortextOS twin guide and its small runtime adapter notes are in
[`operations/PORTABLE-TWIN-OPERATING-GUIDE.md`](operations/PORTABLE-TWIN-OPERATING-GUIDE.md).
The adapter notes for [ChatGPT](operations/adapters/chatgpt.md),
[Claude](operations/adapters/claude.md), [Codex](operations/adapters/codex.md), and
[Grok](operations/adapters/grok.md) are navigation notes only; they do not create separate
identity, task, approval, or schedule authorities.
Organization-specific roles, handoffs, schedules, and private inventories remain in their
private organization records and are not part of the reusable product documentation.
