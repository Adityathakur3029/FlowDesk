import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";

export interface OutgoingEmail {
  to: string | string[];
  from: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailTransport {
  send(email: OutgoingEmail): Promise<{ messageId: string }>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export function createSmtpTransport(opts: SmtpOptions): EmailTransport {
  const transporter = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
  });

  return {
    async send(email) {
      const info = await transporter.sendMail(email);
      return { messageId: info.messageId };
    },
  };
}

// Local development: print the email instead of sending it
export function createConsoleTransport(): EmailTransport {
  return {
    async send(email) {
      const messageId = `console-${randomUUID()}`;
      const to = Array.isArray(email.to) ? email.to.join(", ") : email.to;
      console.log(
        [
          "----- email (console transport) -----",
          `Message-ID: ${messageId}`,
          `From: ${email.from}`,
          `To: ${to}`,
          `Subject: ${email.subject}`,
          "",
          email.text,
          "-------------------------------------",
        ].join("\n"),
      );
      return { messageId };
    },
  };
}
