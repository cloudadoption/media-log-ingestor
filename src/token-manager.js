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

    const { payload } = decoded;
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

    return {
      valid: true,
      payload,
      expiresAt
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message
    };
  }
}
