import { z } from "zod";
import { env } from "../../config/env";
import {
  authNote,
  bearerSecurity,
  errorResponseSchema,
  internalServerErrorResponse,
  jsonResponse,
  PUBLIC_ACCESS_NOTE,
  registry,
  unauthorizedResponse,
  validationErrorResponseSchema,
} from "../../docs/registry";
import { employeeSchema, exampleEmployee } from "../employees/employee.docs";
import { googleLoginSchema } from "./auth.validation";

const domain = env.ORG_EMAIL_DOMAIN;
const exampleAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIuLi4ifQ.signature";

const loginResponseSchema = registry.register(
  "LoginResponse",
  z.object({
    data: z.object({
      accessToken: z.string().meta({
        description:
          "FlowDesk access token: an HS256 JWT with payload `{ sub: employeeId, email, role, iat, exp }`. " +
          "Send it as `Authorization: Bearer <accessToken>`.",
      }),
      tokenType: z.literal("Bearer"),
      expiresIn: z.number().int().meta({ description: "Seconds until the access token expires", example: 28800 }),
      employee: employeeSchema,
    }),
  }),
);

const meResponseSchema = registry.register("CurrentEmployeeResponse", z.object({ data: employeeSchema }));

registry.registerPath({
  method: "post",
  path: "/auth/google",
  tags: ["Auth"],
  summary: "Sign in with Google",
  description:
    "Exchanges a Google ID token for a FlowDesk access token. The frontend gets the ID token from Google Identity Services " +
    "(the `credential` of the Sign in with Google callback) using the same OAuth client as the backend's `GOOGLE_CLIENT_ID`.\n\n" +
    "**1. Authentication (who are you?).** The ID token's signature is checked against Google's certificates, " +
    "and so are `iss`, `exp` and `aud`, which must equal `GOOGLE_CLIENT_ID`. `email_verified` must be true, and the " +
    `lowercased email's domain must be exactly \`${domain}\` (the \`ORG_EMAIL_DOMAIN\` setting). When the token has an \`hd\` ` +
    "(Google Workspace) claim, it must match too.\n\n" +
    "**2. Authorization (are you allowed?).** The employee with that email must exist, must have an ACCEPTED invite, " +
    "and must be active. The first successful login links the Google account (`sub`) to the employee. Later logins must " +
    "use the same Google account.\n\n" +
    "**Access granted:** returns an access token for the other endpoints. The Google ID token is never stored.\n\n" +
    "**Headers:** `Content-Type: application/json` is required for the body to be parsed.\n\n" +
    PUBLIC_ACCESS_NOTE +
    " This is the endpoint that issues access tokens.",
  security: [],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: googleLoginSchema,
          example: { idToken: "eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20ifQ.signature" },
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Signed in", loginResponseSchema, {
      data: { accessToken: exampleAccessToken, tokenType: "Bearer", expiresIn: 28800, employee: exampleEmployee },
    }),
    400: jsonResponse("The body is missing, is not valid JSON, or `idToken` is missing or empty", validationErrorResponseSchema, {
      error: "Validation failed",
      details: [{ path: "idToken", message: "Invalid input: expected string, received undefined" }],
    }),
    401: {
      description:
        "Authentication failed. `INVALID_GOOGLE_TOKEN`: the ID token is malformed, its signature is wrong, it has expired, " +
        "or it was issued for a different OAuth client (`aud`). `GOOGLE_EMAIL_NOT_VERIFIED`: Google reports the email as unverified. " +
        `\`EMAIL_DOMAIN_NOT_ALLOWED\`: the Google account is not an @${domain} account.`,
      content: {
        "application/json": {
          schema: errorResponseSchema,
          examples: {
            invalidToken: { value: { error: "Invalid Google ID token", code: "INVALID_GOOGLE_TOKEN" } },
            emailNotVerified: {
              value: { error: "Your Google email address is not verified", code: "GOOGLE_EMAIL_NOT_VERIFIED" },
            },
            domainNotAllowed: {
              value: { error: `Sign in with your @${domain} Google account`, code: "EMAIL_DOMAIN_NOT_ALLOWED" },
            },
          },
        },
      },
    },
    403: {
      description:
        "Authorization failed. `NOT_INVITED`: no employee has this email, or the employee has no accepted invite " +
        "(for example, one created directly through `POST /employees`). `ACCOUNT_INACTIVE`: the employee has been deactivated. " +
        "`GOOGLE_ACCOUNT_MISMATCH`: the employee is linked to a different Google account, or this Google account is linked to another employee.",
      content: {
        "application/json": {
          schema: errorResponseSchema,
          examples: {
            notInvited: { value: { error: "You have not been invited to FlowDesk", code: "NOT_INVITED" } },
            inactive: { value: { error: "Your account has been deactivated", code: "ACCOUNT_INACTIVE" } },
            accountMismatch: {
              value: {
                error: "This Google account is not the one linked to your FlowDesk account",
                code: "GOOGLE_ACCOUNT_MISMATCH",
              },
            },
          },
        },
      },
    },
    500: internalServerErrorResponse,
    502: jsonResponse("Google's signing certificates could not be fetched, so the token can't be verified. Retry later.", errorResponseSchema, {
      error: "Could not reach Google to verify the sign-in",
      code: "GOOGLE_UNAVAILABLE",
    }),
  },
});

registry.registerPath({
  method: "get",
  path: "/auth/me",
  tags: ["Auth"],
  summary: "Get the signed-in employee",
  description:
    "Returns the employee behind the access token. The employee is re-read from the database, so the role is current.\n\n" +
    authNote(),
  security: bearerSecurity,
  responses: {
    200: jsonResponse("The signed-in employee", meResponseSchema, { data: exampleEmployee }),
    401: unauthorizedResponse,
    500: internalServerErrorResponse,
  },
});
