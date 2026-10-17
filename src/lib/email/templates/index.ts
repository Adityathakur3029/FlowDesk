import { renderInviteMember } from "./inviteMember";

export type { RenderedEmail } from "./types";

// Every email the app can send. A template is a plain function: data in, subject/html/text out.
// Add new templates here; sendEmail() type-checks `data` against the chosen template.
export const templates = {
  inviteMember: renderInviteMember,
} as const;

export type TemplateName = keyof typeof templates;
export type TemplateData<T extends TemplateName> = Parameters<(typeof templates)[T]>[0];
