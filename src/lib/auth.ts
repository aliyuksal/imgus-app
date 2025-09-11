// lib/auth.ts
import { type NextAuthOptions } from "next-auth";
import Google from "next-auth/providers/google";
import Email from "next-auth/providers/email";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { sendMail } from "@/lib/mailer"; // ⬅️ SMTP üzerinden göndereceğiz

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    Email({
      // Mailer’da kullandığın gönderen adresi
      from: process.env.SMTP_FROM!,
      maxAge: 10 * 60, // 10dk
      async sendVerificationRequest({ identifier, url }) {
        const subject = "Imgus • Giriş bağlantınız";
        const text = `Giriş bağlantısı: ${url}\nBağlantı 10 dakika geçerli.`;
        const html = `<div style="font-family:system-ui;max-width:520px;margin:auto">
          <h2 style="margin:0 0 8px">Imgus</h2>
          <p>Giriş için tıklayın (10 dk geçerli):</p>
          <p><a href="${url}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#111;color:#fff;text-decoration:none">Hemen giriş yap</a></p>
          <p style="color:#666;font-size:12px">Eğer bu talebi siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>
        </div>`;

        // Resend yerine doğrudan Mailcow SMTP:
        await sendMail({ to: identifier, subject, html, text });
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user && (user as any).id) (token as any).id = (user as any).id;
      (token as any).id = (token as any).id ?? token.sub ?? null;
      return token;
    },
    async session({ session, token }) {
      (session.user as any).id = (token as any).id ?? token.sub ?? null;
      return session;
    },
  },
  // pages: { signIn: "/signin" },
};