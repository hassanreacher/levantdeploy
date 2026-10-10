import nodemailer from "nodemailer";
import { resolveSmtp } from "@/lib/ops/smtp";

/**
 * Sends an email via SMTP — the `smtp` platform setting (Settings → Email) or env SMTP_*.
 * Without any SMTP configuration (dev) it logs the message to the console instead.
 */
let transport: { key: string; t: nodemailer.Transporter } | null = null;

export async function sendMail(msg: { to: string; subject: string; text: string; html?: string }): Promise<{ delivered: boolean }> {
  const cfg = await resolveSmtp();
  if (!cfg) {
    console.info(`\n[mail:dev] to=${msg.to}\n  subject: ${msg.subject}\n  ${msg.text.replace(/\n/g, "\n  ")}\n`);
    return { delivered: false };
  }
  const key = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
  if (transport?.key !== key) {
    transport = {
      key,
      t: nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : undefined,
        connectionTimeout: 15_000,
      }),
    };
  }
  await transport.t.sendMail({ from: cfg.from, ...msg });
  return { delivered: true };
}
