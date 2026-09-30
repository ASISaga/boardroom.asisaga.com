// API base URL for backend (Azure Functions)
export const API_BASE_URL = 'https://api.boardroom.asisaga.com';
// OpenAPI spec location
// export const OPENAPI_SPEC_URL = `${API_BASE_URL}/openapi.json`;
export const OPENAPI_SPEC_URL = '/api/openapi.json';
// config.js
export const AAD_CONFIG = {
  clientId: "YOUR_CLIENT_ID",
  tenantId: "YOUR_TENANT_ID",
  functionScope: "api://YOUR_FUNCTION_APP_ID/.default",
  redirectUri: window.location.origin
};

// Confindential information should not be hardcoded in production code.
// Client secret
// Certificate or Client assertion key
// API Keys
