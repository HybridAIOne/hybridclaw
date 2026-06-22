---
title: Control Owners
description: Initial control owner map for ISO evidence maintenance.
sidebar_position: 6
---

# Control Owners

Review date: 2026-06-16.

| Owner role | Accountable for | Repo-visible responsibility | Operator evidence required |
| --- | --- | --- | --- |
| ISMS Owner | ISMS scope, policy approval, SoA, risk acceptance | Maintain this package and control matrix links. | Management approval, review minutes, exceptions. |
| Security Owner | Secret handling, cryptography, threat model | Maintain `SECURITY.md`, `TRUST_MODEL.md`, secret threat model. | Key custody, rotation, break-glass records. |
| Engineering Owner | Secure development, CI, source-code controls | Maintain tests, CI, dependency policy, security headers, RBAC code. | Branch protection and repository access review. |
| Access Owner | Admin access, authentication, privileged roles | Maintain RBAC role bundles and access matrix. | User assignments, MFA/SSO evidence, access reviews. |
| Audit Owner | Audit integrity, logging, monitoring | Maintain audit code and verification docs. | Off-host sink, retention, alert rules, monitoring review. |
| Data Owner | Data inventory, retention, deletion, privacy | Maintain data inventory and data-flow notes. | Retention schedule, deletion evidence, PII register. |
| Supplier Owner | Supplier and cloud service governance | Maintain supplier register structure. | DPA/security review, subprocessors, exit plans. |
| Operations Owner | Production config, backup, capacity, network controls | Maintain operational docs and examples. | Host config, backups, restore tests, network diagrams. |
| Incident Owner | Incident response and continuity | Maintain incident steps in `SECURITY.md`. | Tabletop exercises, contacts, post-incident records. |
| People Owner | HR/personnel controls | None by default. | Screening, training, offboarding, confidentiality. |
| Facilities Owner | Physical and environmental controls | None by default. | Office/hosting physical security evidence. |
