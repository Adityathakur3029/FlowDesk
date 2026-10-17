import { z } from "zod";
import { env } from "../../config/env";
import {
  authNote,
  bearerSecurity,
  errorResponseSchema,
  forbiddenResponse,
  internalServerErrorResponse,
  jsonResponse,
  PUBLIC_ACCESS_NOTE,
  registry,
  unauthorizedResponse,
  validationErrorResponseSchema,
} from "../../docs/registry";
import { employeeRole, inviteStatus } from "../../db/schema";
import { employeeSchema, exampleEmployee } from "../employees/employee.docs";
import { acceptInviteSchema, createInviteSchema } from "./invite.validation";

const domain = env.ORG_EMAIL_DOMAIN;
const expiryHours = env.INVITE_EXPIRY_HOURS;
const inviteeEmail = `jane.doe@${domain}`;

const exampleInvite = {
  id: "5f0c2b1e-8f5a-4c1d-9a63-2b7e0d4c9f11",
  emailId: inviteeEmail,
  name: "Jane Doe",
  role: "MEMBER",
  status: "PENDING",
  expiresAt: "2026-10-18T10:00:00.000Z",
  createdAt: "2026-10-15T10:00:00.000Z",
};

const exampleAcceptedEmployee = { ...exampleEmployee, emailId: inviteeEmail, name: "Jane Doe", role: "MEMBER" };

// Mirrors toInviteDto in invite.controller.ts
const inviteSchema = registry.register(
  "EmployeeInvite",
  z
    .object({
      id: z.uuid(),
      emailId: z.email().meta({ description: "Lowercased invitee email" }),
      name: z.string().meta({ description: "Invitee's name; becomes the employee's name on accept" }),
      role: z.enum(employeeRole.enumValues).meta({ description: "Role the employee gets on accept" }),
      status: z.enum(inviteStatus.enumValues).meta({
        description:
          "PENDING until accepted. ACCEPTED once the employee is created, EXPIRED after a late accept attempt, " +
          "REVOKED when replaced by a newer invite or when the email could not be sent.",
      }),
      expiresAt: z.iso.datetime().meta({ description: `createdAt + ${expiryHours} hours` }),
      createdAt: z.iso.datetime(),
    })
    .meta({ example: exampleInvite }),
);

const inviteEnvelopeSchema = registry.register("InviteResponse", z.object({ data: inviteSchema }));

const acceptInviteResponseSchema = registry.register(
  "AcceptInviteResponse",
  z.object({
    message: z.string().meta({ example: "Successfully added" }),
    data: employeeSchema,
  }),
);

registry.registerPath({
  method: "post",
  path: "/invites",
  tags: ["Invites"],
  summary: "Invite a new member",
  description:
    `Invites someone to the organisation. \`email\` is trimmed and lowercased, and its domain must be exactly \`${domain}\` ` +
    "(the `ORG_EMAIL_DOMAIN` setting). Subdomains and lookalike domains are rejected.\n\n" +
    "The invite is recorded and an email is sent to the invitee with a link to " +
    "`{APP_BASE_URL}/invites/accept?token=<token>`. The token is a signed JWT (HS256) whose payload is " +
    "`{ inviteId, email, role, iat, exp }`. It's only sent by email and never returned by the API.\n\n" +
    `The invite is valid for ${expiryHours} hours. Inviting the same email again revokes the previous pending invite, ` +
    "so only the newest link works. If the email can't be sent, the invite is revoked and 502 is returned.\n\n" +
    "**Headers:** `Content-Type: application/json` is required for the body to be parsed.\n\n" +
    authNote("ADMIN", "MANAGER"),
  security: bearerSecurity,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createInviteSchema,
          example: { email: `  Jane.Doe@${domain.toUpperCase()} `, name: "Jane Doe", role: "MEMBER" },
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Invite created and email sent", inviteEnvelopeSchema, { data: exampleInvite }),
    400: jsonResponse(
      `The body is missing, is not valid JSON, or breaks a validation rule: \`email\` must be a valid email of at most 255 characters ` +
        `on the \`${domain}\` domain, \`name\` 1-150 characters after trimming, and \`role\` one of ADMIN, MANAGER or MEMBER. ` +
        "Every failing field is listed in `details`.",
      validationErrorResponseSchema,
      {
        error: "Validation failed",
        details: [{ path: "email", message: `Invalid email: must be an @${domain} address` }],
      },
    ),
    401: unauthorizedResponse,
    403: forbiddenResponse,
    409: {
      description:
        "`EMPLOYEE_EXISTS`: an employee with this email already exists (including deactivated employees). " +
        "`INVITE_PENDING`: a concurrent request created an invite for the same email at the same time.",
      content: {
        "application/json": {
          schema: errorResponseSchema,
          examples: {
            employeeExists: {
              value: { error: `Employee with email ${inviteeEmail} already exists`, code: "EMPLOYEE_EXISTS" },
            },
            invitePending: {
              value: { error: `An invite for ${inviteeEmail} is already being created`, code: "INVITE_PENDING" },
            },
          },
        },
      },
    },
    500: internalServerErrorResponse,
    502: jsonResponse(
      "The invite email could not be sent. The invite is revoked, so retrying creates a fresh one.",
      errorResponseSchema,
      { error: "Could not send invite email", code: "EMAIL_DELIVERY_FAILED" },
    ),
  },
});

registry.registerPath({
  method: "post",
  path: "/invites/accept",
  tags: ["Invites"],
  summary: "Accept an invite",
  description:
    "Accepts an invite using the token from the invite link and creates the employee. The employee's email and role " +
    "come from the signed token payload, and the name from the invite (set when it was created). Only `token` is needed in the body.\n\n" +
    `The invite must be accepted within ${expiryHours} hours of being sent. After that the response is **410 Gone** ` +
    "(`INVITE_EXPIRED`) and the invite is marked EXPIRED. 410 is used instead of 408 because 408 means the HTTP request " +
    "itself timed out, which clients may retry automatically.\n\n" +
    "Each invite can be accepted once. The invite and the new employee are saved in one transaction.\n\n" +
    "**Headers:** `Content-Type: application/json` is required for the body to be parsed.\n\n" +
    PUBLIC_ACCESS_NOTE +
    " The invitee has no account yet; the signed invite token is the proof of access.",
  security: [],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: acceptInviteSchema,
          example: { token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpbnZpdGVJZCI6Ii4uLiJ9.signature" },
        },
      },
    },
  },
  responses: {
    201: jsonResponse("Invite accepted and employee created", acceptInviteResponseSchema, {
      message: "Successfully added",
      data: exampleAcceptedEmployee,
    }),
    400: {
      description:
        "`Validation failed`: `token` is missing or empty (see `details`). " +
        "`INVALID_INVITE_TOKEN`: the token is malformed, its signature is wrong, or it doesn't match a stored invite. " +
        "`INVITE_REVOKED`: the invite was replaced by a newer one, or its email could not be sent.",
      content: {
        "application/json": {
          schema: z.union([validationErrorResponseSchema, errorResponseSchema]),
          examples: {
            validation: {
              value: {
                error: "Validation failed",
                details: [{ path: "token", message: "Invalid input: expected string, received undefined" }],
              },
            },
            invalidToken: { value: { error: "Invalid invite token", code: "INVALID_INVITE_TOKEN" } },
            revoked: { value: { error: "This invite was replaced by a newer one", code: "INVITE_REVOKED" } },
          },
        },
      },
    },
    409: {
      description:
        "`INVITE_ALREADY_ACCEPTED`: the invite was already used. " +
        "`EMPLOYEE_EXISTS`: an employee with this email was created some other way after the invite was sent.",
      content: {
        "application/json": {
          schema: errorResponseSchema,
          examples: {
            alreadyAccepted: {
              value: { error: "This invite has already been accepted", code: "INVITE_ALREADY_ACCEPTED" },
            },
            employeeExists: {
              value: { error: `Employee with email ${inviteeEmail} already exists`, code: "EMPLOYEE_EXISTS" },
            },
          },
        },
      },
    },
    410: jsonResponse(
      `The invite was not accepted within ${expiryHours} hours of being sent. Ask for a new invite.`,
      errorResponseSchema,
      { error: "Invite link has expired. Ask for a new invite.", code: "INVITE_EXPIRED" },
    ),
    500: internalServerErrorResponse,
  },
});
