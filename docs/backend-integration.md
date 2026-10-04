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
