# boardroom.asisaga.com Repository Specification

**v2.0.0 | Jekyll | GitHub Pages | Genesis Ontological Design System**

---

## Identity

The Business Infinity application frontend — conversational Boardroom interface for AI-powered business governance. Jekyll static site deployed on GitHub Pages, backed by `boardroom` Azure Functions at `cloud.businessinfinity.asisaga.com`, consuming `mind.asisaga.com` MCP Apps for agent mind state and human governance.

Whitepaper: `boardroom-whitepaper-v4.md` §6 — Layer 5: Copilot Agent Organization

---

## Visual Ontology

Built on `ASISaga/theme.asisaga.com` via Jekyll `remote_theme`. The Genesis Ontological Design System is not a styling library — it is the visual Ahankara of the ASI Saga organism. The same ontological vocabulary that governs agent identity governs visual identity.

| Semantic Category | Role | Boardroom Usage |
|---|---|---|
| `genesis-environment` | Space as context | Deliberation space, session containers |
| `genesis-entity` | Visual being | Agent avatars, CXO presence cards |
| `genesis-cognition` | Typography as knowing | Decision records, rationale, axiom statements |
| `genesis-synapse` | Interaction as connection | Covenant speech-acts, routing actions |
| `genesis-state` | Condition/becoming | Session status, deliberation state |
| `genesis-atmosphere` | Ambient presence | Resonance field, collective mind visualization |

Sacred SCSS components used directly:

| Component | Usage |
|---|---|
| `consciousness-cards` | CXO agent profiles — Ahankara made visible |
| `genesis-blocks` | Deliberation outputs — Buddhi rendered |
| `transcendent-hero` | Boardroom landing — Possibility declared |

The parallel to the agent stack is exact and intentional:

```
theme.asisaga.com              Visual ontology substrate (remote_theme)
  boardroom.asisaga.com        Visual identity of the Boardroom

mind.asisaga.com               Consciousness substrate (MCP)
  PurposeDrivenAgent           Agent consciousness
    CXO agents                 Domain-specific identity
```

---

## Architecture Position

```
theme.asisaga.com              Visual Ahankara
  └── boardroom.asisaga.com    THIS REPO — Business Infinity frontend
        └── boardroom          Azure Functions (cloud.businessinfinity.asisaga.com)
              └── mind.asisaga.com   MCP Apps — mind state + human governance
```

---

## Technology Stack

| Component | Technology |
|---|---|
| Static site generator | Jekyll (Liquid templates, Markdown) |
| Theme | `remote_theme: ASISaga/theme.asisaga.com` |
| Markup | HTML5 semantic |
| Styling | SCSS via Genesis Ontological Design System — no raw CSS |
| Framework | Bootstrap (via theme) |
| JavaScript | ES6+ modules |
| Components | Web Components — `<boardroom-chat>`, `<mcp-dashboard>`, `<aml-demo>`, `<boardroom-app>` |
| Deployment | GitHub Pages |
| Backend API | `cloud.businessinfinity.asisaga.com` — `boardroom` Azure Functions |
| Mind MCP | `mind.asisaga.com` — MCP Apps UI consumer |

---

## Layouts

From `theme.asisaga.com`:

| Layout | Usage |
|---|---|
| `chatroom.html` | Primary Boardroom deliberation interface |
| `dashboard.html` | Governance — session history, decision log, Resonance trend |
| `app.html` | Onboarding flow — Genesis Sprint CXO enrolment |
| `landing.html` | Boardroom landing — Possibility declared |
| `profile.html` | CXO agent identity — Ahankara view |

---

## Human Interaction Contract

Speech-act types map to `mind.asisaga.com` MCP writes:

| Speech-Act | Interface Action | Mind Write |
|---|---|---|
| Possibility declaration | Covenant prompt | `set_possibility(agent_id, declaration)` |
| Integrity commitment | Commitment registration | `append_integrity(agent_id, commitment)` |
| Responsibility stance | Authorship declaration | Updates `responsibility.jsonld` |
| Covenant acceptance | Genesis Sprint onboarding | Initialises all three Erhard dimensions |
| Directive | Boardroom directive panel | `append_collective(app, "directives", directive)` |
| P1 event acknowledgement | Notification approval | Releases autonomous session trigger |

---

## Onboarding Flow (Genesis Sprint Week 1)

Seven steps — all must complete before agent sessions begin:

1. Covenant acceptance — terms, role acknowledgement
2. Ahankara declaration — identity axis, non-negotiables
3. Possibility declaration — committed future for domain
4. Integrity registration — commitments made; incomplete acknowledged
5. Responsibility stance — authorship declared
6. Manas context review — immutable company/product knowledge pre-loaded by architects
7. Buddhi review — domain wisdom and action plan seeded for persona

Only after step 7: agents hydrated from CXO's own declared mind, sessions begin.

---

## Real-Time Session Interface

`<boardroom-chat>` web component:

- 5-second polling for session updates
- Messages tagged with agent role and speech-act type (proposal, question, objection, resolution)
- Decisions rendered as `consciousness-cards` — structured, role-attributed, timestamped
- Routing tags rendered as synapse actions — `[ROUTE:CFO]`, `[HANDBACK]`, `[COMPLETE]`
- Session Resonance score displayed per turn

---

## Governance Views

| View | Content | Mind Source |
|---|---|---|
| Decision log | Session decisions, rationale, alternatives, counterfactuals | `conversations/{orchestration_id}` |
| Resonance trend | Purpose alignment score across sessions | `collective/resonance.jsonld` |
| Integrity register | Commitments made, kept, incomplete | `{agent_id}/Integrity/integrity.jsonld` |
| Possibility tracker | Declared futures per CXO domain | `{agent_id}/Possibility/possibility.jsonld` |
| Collective mind | Shared consciousness, active directives | `collective/boardroom.jsonld` |
| Board audit report | Exportable structured record for board pack | Generated from decision log |

---

## Invariants

- No direct database access — reads exclusively from `mind.asisaga.com` MCP and `boardroom` API
- No agent code — never imports from any agent package
- No raw CSS — all styling through Genesis Ontological Design System mixins
- Speech-acts are the only write mechanism — humans write to mind only through covenant-typed interface actions
- Onboarding complete only when all seven steps confirmed — no partial onboarding

---

## Specifications

| Specification | Concern |
|---|---|
| `.github/specs/chatroom.md` | `<boardroom-chat>` real-time session interface |
| `.github/specs/onboarding.md` | Genesis Sprint — seven-step mind initialisation |
| `.github/specs/governance.md` | Decision log, Resonance trend, board audit report |
| `.github/specs/speech-acts.md` | Covenant speech-act types and mind write mappings |

## Related Repositories

| Repository | Relationship |
|---|---|
| `ASISaga/theme.asisaga.com` | Visual ontology substrate — `remote_theme` |
| `ASISaga/boardroom` | Backend Azure Functions — business workflows API |
| `ASISaga/mind.asisaga.com` | Consciousness substrate — MCP Apps consumer |
| `ASISaga/aos-infra` | Deployment — `deploy-function-app.yml` reusable workflow |
