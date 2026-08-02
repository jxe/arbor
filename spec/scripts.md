# Scripts
*Part of the [Arbor spec](../spec.md): portable script authoring, compilation boundaries, execution, and consent.*

An Arbor script is an ordinary `.tsx` module that may export components, queries, and mutations. `query` and `mutation` are explicit execution-boundary markers; Arbor does not infer a security boundary from an arbitrary export graph.

## Compiled public surface

For each exported handle, compilation produces a stable function identity, input validation, code identity/version, declared or inferred tree access, and enough result metadata for clients and agents to call it without receiving privileged implementation code.

Literal tree paths contribute precise read/write prefixes. A computed path requires an explicit declaration. Compilation fails when code can address a path not represented by its declared capability, closes over UI-only state, or imports ambient host authority into a handler. Collection predicates intended to remain backing-independent must compile into a driver-executable deterministic form or fail clearly rather than fall back to surprising full-data execution.

The concrete bundler, package graph, generated validators, intermediate representation, and output files are reference choices.

## Queries

A query is a deterministic function of `(resolved workspace snapshot, validated input)`. Its only data door is the scoped Arbor tree API. It has no ambient filesystem, network, process, clock, randomness, credential, or undeclared-tree access.

The runtime records the actual read set. A subscription reruns when a committed change intersects that set and emits an ordered replacement or structural diff defined by the handle surface. A query may call another query by handle, preserving combined access and version provenance.

A query whose data is not materialized locally may be hosted by the relevant authority if that host advertises and enforces the same manifest, validation, access, determinism, and version contract. Mixed-authority queries require explicit composition; they never acquire additional authority merely because one runtime can reach both hosts.

## Mutations

A mutation is validated code running against explicit write prefixes. It performs effects only through Arbor mutations or a selected store's transaction boundary. It returns durable receipts/events and inherits the same retry, conflict, access, and nested-boundary rules as direct clients.

External side effects or centralized invariants are not disguised as deterministic collection mutations. A future authority action requires a separately specified effect and consent contract.

## Components

Components are ordinary React/TSX authoring in a confined UI realm. Workspace data and effects enter through imported query/mutation handles. General network and host APIs are absent. UI-local timers, focus, and animation may exist without becoming data authority.

Cross-tree script imports use absolute Arbor locators and resolve to immutable code identities for one build/execution. Imported handles retain their own declared access; resolving an import cannot silently widen it.

## Consent and confinement

Before first execution in a context, a human-readable consent statement summarizes the resolved trees, read prefixes, write prefixes, hosted execution, and any backing-coupled or external capability. Enforcement must make this statement true. A host process's broader filesystem or credentials do not become script capabilities.

Scripts are callable through the CLI, human clients, and agent tools using the same handle identity and validation. A client interface may differ; the public semantics do not.
