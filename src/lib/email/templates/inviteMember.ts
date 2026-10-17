import type { RenderedEmail } from "./types";

export interface InviteMemberData {
  inviteeName: string;
  inviteeEmail: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
  orgName?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// e.g. "18 Oct 2026, 10:00 UTC"
function formatUtc(date: Date): string {
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

export function renderInviteMember(data: InviteMemberData): RenderedEmail {
  const org = data.orgName ?? "FlowDesk";
  const expires = formatUtc(data.expiresAt);

  const text = [
    `Hi ${data.inviteeName},`,
    ``,
    `You've been invited to join ${org} as ${data.role}.`,
    ``,
    `Accept the invite: ${data.acceptUrl}`,
    ``,
    `This link expires on ${expires}.`,
    `If you weren't expecting this invite, you can ignore this email.`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; line-height: 1.5; color: #1f2933;">
    <p>Hi ${escapeHtml(data.inviteeName)},</p>
    <p>You've been invited to join <strong>${escapeHtml(org)}</strong> as <strong>${escapeHtml(data.role)}</strong>.</p>
    <p>
      <a href="${escapeHtml(data.acceptUrl)}"
         style="display: inline-block; padding: 10px 18px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 4px;">
        Accept invite
      </a>
    </p>
    <p>Or paste this link into your browser:<br><a href="${escapeHtml(data.acceptUrl)}">${escapeHtml(data.acceptUrl)}</a></p>
    <p>This link expires on ${escapeHtml(expires)}.</p>
    <p style="color: #6b7280; font-size: 12px;">If you weren't expecting this invite (sent to ${escapeHtml(data.inviteeEmail)}), you can ignore this email.</p>
  </body>
</html>`;

  return { subject: `You're invited to join ${org}`, html, text };
}
