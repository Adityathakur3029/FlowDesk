import { z } from "zod";

// These schemas validate requests at runtime and also generate the OpenAPI docs
// (see auth.docs.ts), so keep the `.meta` descriptions accurate.

export const googleLoginSchema = z
  .object({
    idToken: z.string().trim().min(1).meta({
      description:
        "Google ID token (a JWT) from Google Identity Services: the `credential` field of the Sign in with Google callback",
      example: "eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20ifQ.signature",
    }),
  })
  .meta({ id: "GoogleLoginRequest" });

export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;
