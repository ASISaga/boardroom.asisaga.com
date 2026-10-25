# Backend Integration Guide

## Overview

This document describes the integration between the Business Infinity frontend (this repository) and the Business Infinity backend services.

## Backend Architecture

The Business Infinity backend is a Python-based serverless application built on Azure Functions and the Agent Operating System (AOS). It provides:

- **Strategic Decision Making**: Multi-agent collaborative decision processes
- **Business Workflow Orchestration**: Automated business processes (product launches, funding rounds)
- **Agent Management**: C-Suite agents (CEO, CFO, CTO, CMO, COO), Founder, and Investor agents
- **Trust & Compliance**: GDPR-compliant data export, deletion, and retention policies
- **Risk Management**: Comprehensive risk tracking and mitigation
- **Knowledge Management**: Centralized knowledge base with versioning
- **Mentor Mode**: Agent training and fine-tuning capabilities
- **Global Boardroom Network**: Covenant-based compliance for autonomous boardrooms

## Backend Repository

**Repository**: [ASISaga/BusinessInfinity](https://github.com/ASISaga/BusinessInfinity)

### Key Components

1. **Agent Operating System (AOS)** - Infrastructure layer providing:
   - Agent lifecycle management
   - Message bus for inter-agent communication
   - Storage services (Blob, Table, Queue, Cosmos DB)
   - ML pipeline for model training and inference
   - Authentication and authorization
   - MCP (Model Context Protocol) integration

2. **Business Agents** - Specialized AI agents:
   - **ChiefExecutiveOfficer**: Strategic leadership and vision
   - **BusinessCFO**: Financial leadership and analysis
   - **BusinessCTO**: Technology leadership and innovation
   - **FounderAgent**: Vision, innovation, entrepreneurial leadership
   - **InvestorAgent**: Investment analysis and funding strategy

3. **Azure Functions API** - RESTful endpoints for:
   - Health checks and system status
   - Agent interactions and queries
   - Strategic decision making
   - Business workflow execution
   - Trust and compliance operations

## API Endpoints

### Core Endpoints

#### Health Check
```
GET /api/health
```
Returns system status and availability of core components (AOS, Service Bus, Storage, MCP).

**Response**:
```json
{
  "status": "ok",
  "components": {
    "aos": { "status": "available" },
    "serviceBus": { "status": "available" },
    "storage": { "status": "available" },
    "mcp": { "status": "available" }
  }
}
```

#### List Agents
```
GET /api/agents
```
Returns all available business agents with their roles, status, and capabilities.

**Response**:
```json
[
  {
    "role": "CEO",
    "status": "online",
    "capabilities": ["strategic_planning", "decision_making", "leadership"]
  }
]
```

#### Ask Agent
```
POST /api/agents/{role}/ask
```
Submit a question or request to a specific business agent.

**Request**:
```json
{
  "message": "What are our strategic priorities for Q1?",
  "context": {}
}
```

**Response**:
```json
{
  "answer": "Based on current market analysis...",
  "confidence": 0.85,
  "metadata": {
    "agent": "CEO",
    "timestamp": "2025-01-10T14:30:00Z"
  }
}
```

### Strategic Decision Making

#### Create Decision
```
POST /api/decisions
```
Submit a strategic decision for multi-agent collaboration and voting.

**Request**:
```json
{
  "type": "strategic",
  "context": "Market expansion opportunity in Southeast Asia",
  "stakeholders": ["CEO", "CFO", "CMO"],
  "params": {
    "urgency": "high",
    "budget_impact": "significant"
  }
}
```

**Response**:
```json
{
  "decision_id": "uuid",
  "status": "queued"
}
```

### Business Workflows

#### Execute Workflow
```
POST /api/workflows/{workflow_name}
```
Execute a predefined business workflow (e.g., product_launch, funding_round).

**Available Workflows**:
- `product_launch`: Market analysis → Product strategy → Technical implementation → Financial planning → Launch
- `funding_round`: Financial assessment → Investor outreach → Pitch preparation → Due diligence → Closing
- `market_analysis`: Market research → Competitive analysis → Opportunity assessment

**Request**:
```json
{
  "params": {
    "product_name": "AI Assistant Pro",
    "target_market": "Enterprise SaaS",
    "launch_date": "2025-Q2"
  }
}
```

**Response**:
```json
{
  "execution_id": "uuid",
  "status": "running",
  "result": {}
}
```

### Trust & Compliance

#### Export Customer Data
```
GET /api/onboarding/export-data
```
GDPR-compliant data export with integrity verification.

**Headers**:
- `x-customer-id`: Customer identifier
- `x-user-id`: User identifier
- `x-functions-key`: API key

**Response**:
```json
{
  "export_id": "uuid",
  "customer_id": "customer-123",
  "export_timestamp": "2025-01-10T14:30:00Z",
  "data_types": ["profile", "decisions", "conversations"],
  "data": {},
  "integrity_hash": "sha256-hash"
}
```

#### Request Data Deletion
```
POST /api/onboarding/request-deletion
```
Request deletion of customer partition data with confirmation workflow.

**Request**:
```json
{
  "customer_id": "customer-123",
  "confirm": false
}
```

**Response**:
```json
{
  "request_id": "uuid",
  "status": "pending_confirmation",
  "sla_days": 2,
  "message": "Confirmation email sent"
}
```

#### Get RBAC Information
```
GET /api/onboarding/rbac
```
Get current user's roles, permissions, and governance defaults.

**Response**:
```json
{
  "user_id": "user-123",
  "customer_id": "customer-123",
  "role": "Admin",
  "permissions": ["read", "write", "delete", "admin"],
  "restrictions": [],
  "governance_defaults": {}
}
```

#### Get Incident Contact Information
```
GET /api/onboarding/incident-contact
```
Get incident response and escalation contact information.

**Response**:
```json
{
  "incident_response": {
    "primary_contact": {
      "email": "security@businessinfinity.asisaga.com",
      "phone": "+1-800-555-0100"
    },
    "escalation_path": []
  },
  "breach_notification": {},
  "compliance_officer": {}
}
```

#### Get Retention Policy
```
GET /api/onboarding/retention-policy
```
Get current data retention and deletion policy information.

**Response**:
```json
{
  "data_retention": {},
  "deletion_policies": {},
  "backup_policy": {},
  "gdpr_compliance": {},
  "policy_version": "1.0"
}
```

## Frontend Integration

### Migration from Legacy Endpoints

The OpenAPI specification includes both legacy and new endpoints for backward compatibility:

**Legacy Endpoints** (Deprecated):
- `/agents` → Use `/api/agents` instead
- `/health` → Use `/api/health` instead

**Recommended Approach**:
1. Update all new code to use `/api/*` endpoints
2. Update existing code incrementally to use new endpoints
3. Legacy endpoints may be removed in future versions

The new endpoints provide enhanced functionality:
- `/api/agents`: Returns detailed agent status and capabilities
- `/api/health`: Returns component-level health status (AOS, Service Bus, Storage, MCP)

### API Base URL

**Production**: `https://cloud.businessinfinity.asisaga.com`

Configured in `/assets/js/config.js`:
```javascript
export const API_BASE_URL = 'https://cloud.businessinfinity.asisaga.com';
```

**Note**: The configuration file also requires Azure AD credentials to be set up:
- `clientId`: Your Azure AD application client ID (set via `AZURE_CLIENT_ID` environment variable)
- `tenantId`: Your Azure AD tenant ID (set via `AZURE_TENANT_ID` environment variable)
- `functionScope`: API scope for your Azure Functions app (set via `AZURE_FUNCTION_SCOPE` environment variable)

These should be configured via environment variables in production rather than hardcoded. Example:
```javascript
// Production configuration using environment variables
export const AAD_CONFIG = {
  clientId: process.env.AZURE_CLIENT_ID,
  tenantId: process.env.AZURE_TENANT_ID,
  functionScope: process.env.AZURE_FUNCTION_SCOPE,
  redirectUri: window.location.origin
};
```

### OpenAPI Specification

The complete API specification is available at:
- Runtime: `/api/openapi.json`
- Cached: `/assets/data/openapi.json`

### Client Libraries

#### BoardroomAPI
Located at `/assets/js/boardroom/boardroomApi.js`

Provides methods for:
- `getAgents()` - List all agents
- `getAgentProfile(agentId)` - Get agent profile
- `startConversation(agentId)` - Start conversation with agent
- `sendMessage(convId, text)` - Send message to conversation
- `getMessages(convId)` - Get conversation messages

#### API Routes
Located at `/assets/js/apiRoutes.js`

Provides dynamic API route resolution using operation IDs from the OpenAPI spec.

## Authentication

The backend uses Azure AD (Entra ID) for authentication:

1. **User Login**: Redirect to Azure AD login page
2. **Token Exchange**: Authorization code exchanged for access token
3. **Token Storage**: Access token stored in sessionStorage
4. **API Calls**: Token included in Authorization header

### Token Management

```javascript
function authHeader() {
  const token = localStorage.getItem('access_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}
```

### Boardroom sign-in checklist

After MSAL sign-in, and before the hydrate, `boardroom-app-new.js` calls
`GET {api}/auth/status` with the same bearer token as `/ag-ui`:

- `ready: true`: the boardroom hydrates as usual.
- `ready: false`: the chat is replaced by a checklist. It shows one row per
  `checks[]` entry (✓, ✗ or "not checked"), the signed-in user and tenant ID
  (with a copy button), guidance for the `action`, and a **Copy diagnostics**
  button. The guidance names who has to act:
  - `request_onboarding`: Boardroom support onboards the tenant. The page also
    shows the admin-consent link, the app client ID, and a **Check again**
    button. Admin consent only creates the Enterprise application in the
    customer tenant; `/auth/status` stays `request_onboarding` until the
    operator activates the tenant's `COMPANY_REGISTRY` entry (backend guide
    B3–B6). When Entra returns to the page with
    `?admin_consent=True&tenant=<tid>` (or `error`/`error_description`), the
    page reports the result, remembers the grant per tenant in localStorage
    (`boardroom_admin_consent:<tid>`), removes those query parameters, and the
    checklist then shows consent as done and activation as the remaining step
    ([ASISaga/boardroom#72](https://github.com/ASISaga/boardroom/issues/72)).
  - `request_role`: the organization's Entra admin assigns the role. The user
    then signs out and signs in again.
  - `sign_in`: the page signs in again, using the redirect cooldown guard. It
    shows a configuration error instead for `audience_mismatch` and
    `issuer_mismatch`.
  - `retry`: the page offers a Retry button.
  - `contact_support`: the page shows the detail and the `error_id`.
- A 401 or 403 from `/ag-ui` mid-session re-fetches `/auth/status`. Error
  bodies are read by `code`, `action`, `error_id` and `required_role`. The
  regex on `detail` is used only when an older backend has no `/auth/status`.
- Admin controls (`[data-boardroom-admin]`) are shown only when
  `capabilities.administer` is `true`.
- `tenant_id` and `company_id` are only displayed. The page never sends them to
  the backend (INV-5).

### Speaker relay (Mind context, prompt, inference)

For `company-admin` viewers the backend sends a `CUSTOM` event named
`speaker_relay` with `{actor, mind_context, prompt, inference}`
([ASISaga/boardroom#78](https://github.com/ASISaga/boardroom/issues/78)).
It arrives before the speaker's text events, or later on its own.

- `CopilotKitClient` matches the relay to the speaker's message in the run
  and reports it through `onSpeakerRelay(relay, messageId, runId)`, never
  `onCustomEvent`.
- `MessageView` (`assets/js/boardroom-app/message-view.js`) adds a collapsed
  "Mind / Prompt / Inference" panel (`.boardroom-relay`) under that speaker's
  message.
- The values are set as text only, never HTML, because prompts contain user
  and company data.
- A missing, empty or unrecognised relay shows nothing and is not an error.

### Owner's agenda: decisions, consent digest, veto

O (boardroom-orchestration) keeps a per-company agenda in the Mind, behind
`BOARDROOM_AGENDA`, which is off by default
([spec 21](https://github.com/ASISaga/boardroom-orchestration/blob/main/.github/specs/21-agenda.md),
task `a2a/tasks/0038-agenda.md`, issue
[#73](https://github.com/ASISaga/boardroom.asisaga.com/issues/73)). The
human owner reserves nothing. The owner's only power is a veto. The screen
design will come from the founder later. What exists now:

- An **Agenda** header button (`[data-boardroom-admin]`), shown only when
  `capabilities.administer` is `true`.
- It opens `AgendaPanel` (`assets/js/boardroom-app/agenda-panel.js`). The
  panel's data logic is in `agenda-model.js`.

**Proposed path: F endpoints next to `/ag-ui`.** O adds an entry point that F
calls. F derives the company from the token (INV-5). F enforces the admin
role itself and must not rely on the hidden button. Company data goes to
operators and the company's owner only.

```
GET  {api}/agenda          → the owner view (below); Cache-Control: no-store
POST {api}/agenda/veto     {"item": "item.7", "reason": "…", "decided_at": "…"}
     → 200 the updated decision; F calls
       Agenda.veto(handle=item, by="owner", reason, now, settings)
       over AgendaStore.update
```

Owner view (`boardroom.agenda.owner_view.v1`). It reads the `agenda`,
`agenda:item:{n:08d}` and `agenda:delegation` rows.

```json
{
  "schema": "boardroom.agenda.owner_view.v1",
  "enabled": true,
  "now": "2026-10-24T12:00:00Z",
  "veto_window_hours": 24,
  "decisions": [{
    "item": "item.7", "title": "…", "text": "…", "reason": "…", "forecast": "…",
    "level": "one|pair|board", "deciders": ["CTO", "CFO"],
    "decided_at": "…", "effective_at": "…", "veto_window_ends_at": "…",
    "status": "pending|effective|vetoed|called_in",
    "vetoed": {"by": "owner", "at": "…", "reason": "…"}, "called_in": null
  }],
  "consent_digest": {"decisions": [/* same shape, oldest first, ≤ digest_lines_max */], "more": 3}
}
```

- `decisions` lists the pending and recent decisions. For each one the panel
  shows:
  - the item, text, reason and forecast;
  - the level and deciders;
  - `decided_at` and `effective_at`;
  - the status;
  - the veto window left.
- The window ends at `veto_window_ends_at`. When that is missing, it ends at
  `decided_at` + `veto_window_hours` (placeholder: 24 h). The countdown uses
  the server's `now`, so the browser clock does not matter.
- The consent digest lines read
  `[item.N] <title>: <decision> (<DECIDERS>, one CXO|pair)`, followed by
  `… and K more not shown.`
- The veto form appears only while the decision is `pending` or `effective`
  and inside its window. A reason is required, up to 8000 characters.
  `decided_at` is sent so that a decision recorded after the view was loaded
  is not vetoed by mistake. F may refuse a mismatch with 409.
- Outside the window, O refuses the veto. F answers 409 with
  `code: "veto_window_closed"`, and the panel reloads.
- Agenda off: F answers `enabled: false`, or an error with
  `code: "agenda_disabled"`. A 404 with no code means the backend has no
  agenda endpoint yet. A 401 or 403 goes through the `/auth/status` re-check.
- Titles, decisions and reasons are untrusted CXO text. The panel sets them
  as `textContent` only, never as HTML.

### The board's work: the turn trace (visible board, step 4)

The page shows what the board is doing from the turn trace that
boardroom-orchestration fixed in step 1 (`boardroom.trace.v1`,
`docs/turn-trace.md` in that repository): a status strip, one timeline per
turn, failure cards, and an operator view. Trace entries carry counts,
sizes, durations, handles and cause classes only; speech is shown as
before. Everything is rendered with `textContent`.

**What the page reads (live).** A trace entry may arrive on the AG-UI
stream either as `CUSTOM` `name: "boardroom_trace"`, `value: <entry>`, or
as a bare `data:` frame with `schema: "boardroom.trace.v1"` and no `type`
(step 1's wire). `CopilotKitClient` hands both to `onTraceEntry`; neither is
speech, a custom event or a log line. Heartbeats (`live: true`, `n: null`)
replace each other and drive the wait countdown (`details.wait_remaining_s`,
measured from arrival). Any bytes of the stream, keepalives included, count
as activity.

**What the page reads (hydrate), proposed to the Function App (step 3):**

| `STATE_SNAPSHOT` key | Shape | Used for |
|---|---|---|
| `turn_traces` | `[{turn_id, entries: [...], trace_unavailable?}]` | timelines after a reload |
| `memory` | `{status: ok\|empty\|unavailable, cause, affects: [history, grounding], retrying, next_retry_at}` | the memory banner |
| `board_status` | `{running, reason, next_scheduled}` | the idle line |
| `trace_audience` | `"operator"` when the server serves operator entries | the operator view |

An older backend that sends only `live_only` / `live_only_reason` still gets
a banner; what it does not say is shown as "not reported". "Retry now"
(and the page's own re-read, on the server's `next_retry_at` or every
minute) is a hydrate with `forwardedProps.retry_history: true`.

**Audiences.** The page never asks for an audience: the Function App
decides which entries reach a session (step 1's `x-boardroom-trace` header
is set by the server). `GET /auth/status` `capabilities.operate` (proposed)
or the hydrate's `trace_audience: "operator"` turn on the operator view
(technical detail of every phase, the failure card's attempts and waits,
prompt size, "Copy trace"). An owner session keeps owner entries only: any
operator entry that arrives anyway is dropped unrendered and logged once as
a server fault.

**Gaps are marked, never guessed.** A turn whose speech arrived with no
trace says "Trace unavailable"; an entry the page cannot read is counted,
not rendered; `skipped` + `details.not_reported` reads "not reported"; on an
operator stream a gap in `n` is listed as missing. "Heard nothing for N s"
appears after 5 s without an event while a run is open (the contract's
interval); after 15 s with no bytes at all, the strip says the connection
may be broken, and when the browser is offline it says so.

**Log panel.** A run with no deliberation (a page load, an empty run) is
one idle line, not "Run started / State snapshot / Run finished". The
board's lines are labelled by turn and honour the level selector. MSAL
lines go to a separate, collapsed "Browser library log", off by default.

Models (DOM-free, tested in `tests/agui/trace.contract.test.js`):
`trace-model.js`, `board-status-model.js`, `memory-banner-model.js`,
`client-log-model.js`. Views: `trace-view.js` (strip and timelines),
`run-status.js` (banner), `chat-log.js` (log panel).

### Liveness as status, and only what is known (follow-up 3; issue #78)

**Liveness.** `CUSTOM` `boardroom_liveness` (about every 5 s while a run is
open) feeds the status strip and is never a log line (`liveness-model.js`).
The value is read tolerantly; a field that is not sent is "not reported":
`running`, `phase`, `agent`, `elapsed_s`, `since_last_word_s`, `waiting_for`,
`wait_s`, `wait_remaining_s`, `wait_ends_at` (+ `server_now`), `turn_id`.
The strip shows running or idle, speaker and phase, run time, time since the
board's last word, and the rate-limit wait with a countdown. The end of a
wait is `wait_remaining_s` from arrival; else `wait_ends_at` (shifted by
`server_now`); else, when only `wait_s` is sent, the first heartbeat that
reported that wait plus its length ("about N s left"). A heartbeat resets the
quiet clock (5 s / 15 s thresholds unchanged). The count of heartbeats is in
the operator detail.

**Log order.** Heartbeat lines used to appear above "Run started" because the
log holds a run's lifecycle lines until the run holds deliberation, while
other CUSTOM lines were written at once. Liveness no longer writes lines, and
any line that is not held first releases the lines that are, so the log keeps
arrival order.

**More hydrate `STATE_SNAPSHOT` keys (proposed, boardroom#84):**

| Key | Shape | Used for |
|---|---|---|
| `board_status.schedule` | `{status: scheduled\|none\|unknown, next_at, cause}` | the three schedule answers; a missing one is "not reported" (a bare `next_scheduled: null` is never read as "none") |
| `room` | `[{agent_id, name?, role?, online?}]` or `{members: [...]}` | the members panel and its count; none reported: "not reported", no names |
| `access` | `{roles: [...], audience: owner\|operator, token: ok\|stale, detail?}` | the access line; an owner sees only the view; "Sign in again" on a stale token |
| `memory.detail` | string | the failed history read's detail, in the operator detail only |
| `turn_traces[].trace` | `{requested, arrived, withheld, lost}` | why a past turn has no trace |

`RUN_FINISHED.result.trace` (`{requested, arrived, withheld}`) tells a live
turn's "no trace" apart: the board sent none, withheld for the role, was not
asked, or (history) the stored trace was lost; with no report the page keeps
"Trace unavailable" and says the server did not say why. A trace stored after
the run appears under its turn when history is next read.

**Failures.** A failed run is one card. With a trace card, the server's class
and words from the `RUN_ERROR` are added to it; with none, the failing
speaker's words (or the server's) become the card, tagged "Server's cause
class: <words> [class]" as sent (`internal` stays `internal`). No separate
`[ERROR]` line is written for it.

## Client module layout

The two entry points keep their paths and public APIs; their logic lives in
small classes beside them.

- `assets/js/copilotkit-client.js` — `CopilotKitClient` (runs, callbacks,
  event dispatch, `fetchAuthStatus`, `fetchAgenda`, `vetoDecision`). Helpers in `assets/js/copilotkit/`: `AgUiHttp` (headers,
  HTTP errors), `SseReader`, `JsonPatch`, `SpeakerRelay` /
  `SpeakerRelayTracker`, `AgUiRun` (per-run state).
- `assets/js/boardroom-app-new.js` — `<boardroom-app>` (`BoardroomApp`,
  lifecycle and public API). Collaborators in `assets/js/boardroom-app/`,
  each constructed with the app element: `MsalAuth`, `AuthChecklist`,
  `AuthGate`, `AguiSession`, `RunStatus`, `TraceView`, `MessageView`,
  `MembersPanel`, `ChatLog`, `BoardroomChrome`, `AgendaPanel` (with the
  DOM-free `agenda-model.js`; `TraceView`, `RunStatus` and `ChatLog` use the
  DOM-free `trace-model.js`, `board-status-model.js`,
  `memory-banner-model.js` and `client-log-model.js`); shared values in
  `constants.js`.

## Rate Limiting

- **Global**: 1000 requests/hour per user
- **Compliance Endpoints**: 10 requests/hour per user
- **Export/Deletion**: 1 request/24 hours per user

### Rate Limit Headers

The API includes rate limit information in response headers:
- `X-RateLimit-Limit`: Maximum requests allowed in the time window
- `X-RateLimit-Remaining`: Requests remaining in current window
- `X-RateLimit-Reset`: Unix timestamp when the rate limit resets

### Rate Limit Exceeded

When rate limits are exceeded, the API returns:

**Response Code**: `429 Too Many Requests`

**Response Body**:
```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Please retry after 300 seconds.",
    "details": {
      "retry_after": 300,
      "limit": 1000,
      "window": "1 hour"
    }
  }
}
```

The response includes a `Retry-After` header indicating how long to wait before retrying (in seconds).

## Error Handling

All API errors follow this format:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Missing required parameter: boardroomId",
    "details": {
      "parameter": "boardroomId",
      "location": "query"
    }
  }
}
```

**Error Codes**:
- `INVALID_REQUEST`: Malformed request
- `UNAUTHORIZED`: Missing or invalid authentication
- `FORBIDDEN`: Insufficient permissions
- `NOT_FOUND`: Resource not found
- `RATE_LIMITED`: Too many requests
- `INTERNAL_ERROR`: Server error

## Development

### Local Development

1. Backend runs on Azure Functions locally: `http://localhost:7071`
2. Frontend can connect to local backend by updating `API_BASE_URL` in `/assets/js/config.js`

### Testing

Use the OpenAPI specification to:
- Generate API client code
- Validate requests and responses
- Test API endpoints

### Monitoring

Backend provides:
- Health checks at `/api/health`
- System status at `/status`
- Component availability monitoring

## Global Boardroom Network

The backend supports covenant-based compliance for the Global Boardroom Network:

- **LinkedIn Verification**: Enterprise identity verification
- **Peer Recognition**: Network validation and compliance badges
- **Covenant Ledger**: Immutable inter-boardroom agreement tracking
- **Network Discovery**: Global boardroom peer discovery
- **Federation Support**: Join and participate in boardroom federations

## Related Documentation

- [API Integration Specification](/docs/specifications/api-integration.md) - Detailed API integration patterns
- [Server TODO](/docs/SERVER_TODO.md) - Backend feature requirements
- [Backend Repository](https://github.com/ASISaga/BusinessInfinity) - Backend source code
- [Agent Operating System](https://github.com/ASISaga/AgentOperatingSystem) - Infrastructure layer

## Support

For backend-related issues or questions:
- Open an issue in the [BusinessInfinity repository](https://github.com/ASISaga/BusinessInfinity/issues)
- Contact the development team

## Changelog

### 2025-01-10
- Added comprehensive backend integration documentation
- Updated OpenAPI specification with all backend endpoints
- Documented trust and compliance features
- Added Global Boardroom Network capabilities
