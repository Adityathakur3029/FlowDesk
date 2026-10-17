import { env } from "../../config/env";
import { templates, type TemplateData, type TemplateName } from "./templates";
import { createConsoleTransport, createSmtpTransport, type EmailTransport } from "./transports";

export interface SendEmailOptions<T extends TemplateName> {
  to: string | string[];
  // Sender address; defaults to MAIL_FROM
  from?: string;
  template: T;
  data: TemplateData<T>;
}

let transport: EmailTransport | undefined;

// Built on first use so importing this module never opens an SMTP connection
function getTransport(): EmailTransport {
  if (!transport) {
    transport =
      env.EMAIL_TRANSPORT === "smtp"
        ? createSmtpTransport({
            host: env.SMTP_HOST!,
            port: env.SMTP_PORT!,
            secure: env.SMTP_SECURE,
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          })
        : createConsoleTransport();
  }
  return transport;
}

// Renders `template` with `data` and sends it. Transport errors are thrown to the caller.
export async function sendEmail<T extends TemplateName>(opts: SendEmailOptions<T>): Promise<{ messageId: string }> {
  const render = templates[opts.template] as (data: TemplateData<T>) => ReturnType<(typeof templates)[T]>;
  const { subject, html, text } = render(opts.data);
  return getTransport().send({ to: opts.to, from: opts.from ?? env.MAIL_FROM, subject, html, text });
}
