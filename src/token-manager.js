import jwt from 'jsonwebtoken';

/**
 * Decodes and validates a JWT token
 * @param {string} token - JWT token to validate
 * @returns {Object} Decoded token payload with validation info
 */
export function validateToken(token) {
  try {
    // Decode without verification (we're just checking structure and expiration)
    const decoded = jwt.decode(token, { complete: true });

    if (!decoded) {
      return {
        valid: false,
        error: 'Invalid token format'
      };
    }

    const payload = decoded.payload;
    const now = Math.floor(Date.now() / 1000);

    // Check expiration
    if (payload.exp && payload.exp < now) {
      return {
        valid: false,
        error: 'Token has expired',
        expired: true,
        expiresAt: new Date(payload.exp * 1000)
      };
    }

    // Calculate time until expiration
    const expiresAt = payload.exp ? new Date(payload.exp * 1000) : null;
    const expiresInDays = payload.exp ? Math.floor((payload.exp - now) / 86400) : null;

    // Check if token has required scopes (if present)
    const scopes = payload.scopes || payload.scope?.split(' ') || [];
    const hasLogRead = scopes.includes('log:read');
    const hasLogWrite = scopes.includes('log:write');

    return {
      valid: true,
      payload,
      expiresAt,
      expiresInDays,
      scopes,
      hasLogRead,
      hasLogWrite,
      hasRequiredScopes: hasLogRead && hasLogWrite
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message
    };
  }
}
