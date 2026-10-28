# Verifying the compiler as a security boundary

**Touches:** spec 07 (compilation, confinement, consent).

**Open.** How should handle extraction, validator generation, realm separation and access
inference be verified as security boundaries? A compiled document's declared handles and
access are what consent shows and enforcement checks, so a compiler bug could widen what a
document reaches without anyone seeing it.

**Settled.** Consent shows the declared prefixes, and broad or computed declarations stay
visibly broad (spec 07 §6; Joe, 2026-10-28). Queries get no clock, randomness or I/O, and a
mutation's time and generated IDs come from its runner (spec 07 §4 and §5).
