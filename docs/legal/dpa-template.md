# Data processing agreement (template)

**DRAFT FOR COUNSEL. Not legal advice, not signed, not in force.** Written 2026-11-02 from the repository only. Square-bracket items are unknowns the owner or counsel must fill. Nothing here claims the service is compliant.

## 0. Who is who (open question)

Whether the guild admin is the controller and the service is a processor, or the two are joint controllers for some data, is undecided (SYNTHESIS Part 5e, "controller/processor split"). This template assumes the common case: the **guild admin (Customer) is controller** of member data entered for their guild, and the **Provider** (the selling entity, [name; entity not yet formed]) is **processor**. Counsel to confirm, and to say which data (for example login and abuse prevention) the Provider holds as its own controller.

| Term | Value |
| :--- | :--- |
| Customer (controller) | [guild admin or organisation name] |
| Provider (processor) | [selling entity; unknown] |
| Service | The hosted guild companion board and bot |
| Effective date | [date] |
| Governing law / venue | [counsel] |

## 1. Article 28(3) items

Each item names the GDPR requirement and the draft clause. "Evidence" points to what exists in this repository today; "gap" is a thing not yet true.

### 1.1 Subject matter, duration, nature and purpose (Art. 28(3) opening)
The Provider processes personal data to run the service for the Customer's guild: sign-ups, schedules, roster, assistant answers. Duration: the term of the subscription plus the deletion period in 1.8. Nature: storage, retrieval, display, and transmission to sub-processors listed in Annex 3.

### 1.2 Documented instructions (Art. 28(3)(a))
The Provider processes personal data only on the Customer's documented instructions (this agreement and the Customer's use of the service settings), including for transfers outside the EEA/UK, unless law requires otherwise, in which case the Provider tells the Customer first where lawful. The Provider tells the Customer if it thinks an instruction breaches data-protection law.

### 1.3 Confidentiality (Art. 28(3)(b))
Persons authorised to process are bound by confidentiality. [Who has production access today is unverified; see `docs/runbooks/secrets.md`. Fill in.]

### 1.4 Security of processing (Art. 28(3)(c), Art. 32)
Measures are listed in Annex 2. Today's evidence: salted-hash member keys, secrets held as Worker secrets, signature checks on Discord interactions, a rate-limited public ask route. Known gaps: no branch protection on `master`; export of data is not built; full-table erase not verified (`docs/data-inventory.md`, "Known gaps"). The list in Annex 2 must be reviewed before signing.

### 1.5 Sub-processors (Art. 28(2) and 28(3)(d))
The Customer gives [general / specific] authorisation for the sub-processors in `docs/subprocessors.md` (Annex 3). The Provider gives [30] days' notice of additions or replacements by [channel; undecided, open item 3 in `subprocessors.md`]; the Customer may object on reasonable grounds, and if unresolved may end the service and receive a pro-rata refund [commercial term for owner]. The Provider imposes on each sub-processor the same data-protection obligations in writing and stays liable for them.

### 1.6 Assistance with data-subject requests (Art. 28(3)(e))
The Provider helps the Customer, by appropriate measures, to answer requests for access, correction, erasure, restriction, portability and objection. Evidence: members can erase their account via `DELETE /me`. Gap: export is not built; erase coverage per table unverified. Response time promised to Customer: [counsel; propose 5 working days].

### 1.7 Assistance with Articles 32 to 36 (Art. 28(3)(f))
The Provider helps with security, breach notification, impact assessments and prior consultation, taking into account the nature of processing. Breach notification to the Customer: **without undue delay and in any case within [24] hours of the Provider becoming aware** [the 24 h figure is a proposal, not a legal minimum; counsel to set], following `docs/runbooks/breach.md`. This leaves the Customer room inside its own 72-hour clock under Art. 33(1).

### 1.8 Deletion or return at end of services (Art. 28(3)(g))
At the Customer's choice, the Provider deletes or returns all personal data after the service ends, and deletes existing copies unless law requires storage. Proposed: [30] days after termination for return, then deletion; backups age out within [period; D1 Time Travel retention is set by Cloudflare and was not checked]. Retention schedule in `docs/privacy.md` and `docs/data-inventory.md` applies meanwhile.

### 1.9 Information and audits (Art. 28(3)(h))
The Provider makes available information needed to show compliance and allows audits by the Customer or its auditor [frequency, notice, cost split: counsel]. Self-serve evidence: open runbooks and the public repository content, where the owner decides to publish them.

### 1.10 Processor contract on request and flow-down (Art. 28(4), 28(9))
In writing, including electronic form. Flow-down to sub-processors as 1.5.

### 1.11 International transfers (Chapter V)
[Unknown.] Sub-processors are US-headquartered or global vendors; the mechanism (SCCs, UK addendum, adequacy or the EU-US Data Privacy Framework status of each vendor) was not checked. Counsel and the owner fill Annex 3.

## Annex 1: Processing details

| Item | Draft content |
| :--- | :--- |
| Data subjects | The Customer's guild members and admins |
| Categories | Discord id, display name, avatar, guild roles; sign-up choices and availability; questions typed to the assistant and the answers; hashed guest IP for rate limits (24 h) |
| Special categories | None intended. Free-text fields could contain any; the Customer is told not to enter them. |
| Retention | As `docs/privacy.md` (for example Ask history 90 days, intents 7 days, guest limits 24 h). The synthesis targets are not all built; verify before signing. |
| Frequency | Continuous |

## Annex 2: Technical and organisational measures (to verify)

Access control by Discord login and member key; least-privilege Cloudflare roles [unverified]; secret rotation per `docs/runbooks/secrets.md`; backups and restore drill per `docs/runbooks/backup-restore.md`; incident handling per `docs/runbooks/incident.md`; change control by pull request with tests (`CONTRIBUTING.md`). Add: logging, encryption in transit (Cloudflare TLS) and at rest (Cloudflare) [vendor statement not checked].

## Annex 3: Sub-processors
See `docs/subprocessors.md`. Fill location and transfer mechanism per vendor.

## Signatures
[Customer] ____________ [Provider] ____________ [date]

## Questions for counsel
1. Controller or processor, per data category, and does the Provider also act as controller for login and abuse prevention?
2. Is a click-through DPA acceptable for a 4 USD per month plan, and does the Discord Premium Apps agreement affect it?
3. Is a 24 hour Provider-to-Customer notice right, and what liability cap applies?
4. Transfer mechanism per sub-processor, and whether free-tier AI vendors can be sub-processors at all.
