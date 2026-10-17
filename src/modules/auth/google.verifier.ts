import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env";
import { BadGatewayError, UnauthorizedError } from "../../lib/errors";

// The only file that talks to Google, so it's easy to stub later
const client = new OAuth2Client(env.GOOGLE_CLIENT_ID);

export interface GoogleIdentity {
  sub: string;
  email: string; // lowercased
  emailVerified: boolean;
  hd?: string; // Google Workspace domain, when the account belongs to one
}

const invalidToken = () => new UnauthorizedError("Invalid Google ID token", "INVALID_GOOGLE_TOKEN");

// Verifies signature (Google's certs), iss, aud (= GOOGLE_CLIENT_ID) and exp.
// Business rules (email_verified, domain) are applied by the auth service.
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  // Fetch (or reuse cached) signing certs first so an outage is a 502, not a 401
  try {
    await client.getFederatedSignonCertsAsync();
  } catch {
    throw new BadGatewayError("Could not reach Google to verify the sign-in", "GOOGLE_UNAVAILABLE");
  }

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw invalidToken();
  }
  if (!payload?.sub || !payload.email) throw invalidToken();

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    hd: payload.hd?.toLowerCase(),
  };
}
