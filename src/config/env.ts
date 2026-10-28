import "dotenv/config";
import { z } from "zod";

// App configuration read from .env. Validated once at import so a missing or bad
// value fails at startup instead of on the first request that needs it.
const envSchema = z
  .object({
    ORG_EMAIL_DOMAIN: z
      .string()
      .trim()
      .toLowerCase()
      .transform((d) => d.replace(/^@/, ""))
      .pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "must be a domain like saajha.org")),
    INVITE_TOKEN_SECRET: z.string().min(32, "must be at least 32 characters"),
    INVITE_EXPIRY_HOURS: z.coerce.number().int().positive().default(72),
    APP_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
    MAIL_FROM: z.string().trim().min(1),
    EMAIL_TRANSPORT: z.enum(["console", "smtp"]).default("console"),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_SECURE: z.stringbool().default(false),
    // Google sign-in: the ID token's `aud` must equal this OAuth web client ID
    GOOGLE_CLIENT_ID: z.string().trim().min(1),
    // HMAC secret for FlowDesk access tokens; keep it different from INVITE_TOKEN_SECRET
    AUTH_JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
    // Access token lifetime in jsonwebtoken `expiresIn` format (e.g. 8h, 30m)
    AUTH_JWT_EXPIRES_IN: z.string().trim().default("8h"),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_TRANSPORT !== "smtp") return;
    for (const key of ["SMTP_HOST", "SMTP_PORT"] as const) {
      if (env[key] === undefined || env[key] === "") {
        ctx.addIssue({ code: "custom", path: [key], message: "required when EMAIL_TRANSPORT=smtp" });
      }
    }
  });

function loadEnv() {
  // Treat `KEY=` (empty) as unset so optional/defaulted values behave as expected
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(result.data);
}

export const env = loadEnv();
export type Env = typeof env;
