import { z } from "zod";
import { env } from "../../config/env";
import { roleSchema } from "../employees/employee.validation";

// These schemas validate requests at runtime and also generate the OpenAPI docs
// (see invite.docs.ts), so keep the `.meta` descriptions accurate.

const orgDomain = env.ORG_EMAIL_DOMAIN;

export const createInviteSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email().max(255))
      // Exact match: sub.saajha.org and saajha.org.evil.io are rejected
      .refine((email) => email.split("@")[1] === orgDomain, {
        message: `Invalid email: must be an @${orgDomain} address`,
      })
      .meta({
        description:
          `Invitee's organisation email. Trimmed and lowercased; the domain must be exactly \`${orgDomain}\` ` +
          "(the `ORG_EMAIL_DOMAIN` setting), subdomains are rejected.",
        // The pipe hides the email/max checks from the generator, so state them here
        format: "email",
        maxLength: 255,
        example: `jane.doe@${orgDomain}`,
      }),
    name: z.string().trim().min(1).max(150).meta({
      description: "Invitee's full name, used for the employee on accept; trimmed; 1-150 characters",
      example: "Jane Doe",
    }),
    role: roleSchema.meta({ description: "Role the employee gets when they accept the invite" }),
  })
  .meta({ id: "CreateInviteRequest" });

export const acceptInviteSchema = z
  .object({
    token: z.string().min(1).meta({
      description: "Invite token from the `token` query parameter of the invite link",
      example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpbnZpdGVJZCI6Ii4uLiJ9.signature",
    }),
  })
  .meta({ id: "AcceptInviteRequest" });

export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
