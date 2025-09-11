// src/lib/mailer.ts
import nodemailer from "nodemailer";

const {
  SMTP_HOST,
  SMTP_PORT = "587",
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  SMTP_REPLY_TO,
} = process.env;

if (!SMTP_HOST || !SMTP_FROM) {
  console.warn("[mailer] SMTP_HOST / SMTP_FROM eksik; mail gönderimleri hata verir.");
}

export const transporter = nodemailer.createTransport({
  host: SMTP_HOST,                          // mail.imgus.app
  port: Number(SMTP_PORT),                  // 587
  secure: Number(SMTP_PORT) === 465,        // 465 ise true, 587 ise false (STARTTLS)
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  pool: true,
  maxConnections: 5,
  maxMessages: 100,
});

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) {
  return transporter.sendMail({
    from: SMTP_FROM!,           // "Imgus <no-reply@imgus.app>"
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    replyTo: SMTP_REPLY_TO || undefined,
  });
}