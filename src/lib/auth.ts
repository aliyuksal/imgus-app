// lib/auth.ts
import { type NextAuthOptions } from "next-auth";
import Google from "next-auth/providers/google";
import Email from "next-auth/providers/email";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

async function sendWithResend(to: string, subject: string, html: string, text?: string) {
  if (process.env.EMAIL_DRY_RUN === "1") return { id: "dry_run" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM!,
      to, subject, html, text,
      reply_to: process.env.REPLY_TO || undefined,
    }),
  });
  if (!r.ok) throw new Error(`Resend failed: ${r.status}`);
  return r.json();
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    Email({
      from: process.env.EMAIL_FROM!,
      maxAge: 10 * 60,
      async sendVerificationRequest({ identifier, url }) {
        const subject = "Imgus • Giriş bağlantınız";
        const text = `Giriş bağlantısı: ${url}\nBağlantı 10 dakika geçerli.`;
        const html = `<div style="font-family:system-ui">
          <h2>Imgus</h2>
          <p>Giriş için tıklayın (10 dk geçerli):</p>
          <p><a href="${url}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#111;color:#fff;text-decoration:none">Hemen giriş yap</a></p>
        </div>`;
        await sendWithResend(identifier, subject, html, text);
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // İlk login anında user objesi gelir; varsa id'yi token'a koy.
      if (user && (user as any).id) {
        (token as any).id = (user as any).id;
      }
      // PrismaAdapter ile genelde token.sub zaten User.id'dir; yoksa fallback:
      (token as any).id = (token as any).id ?? token.sub ?? null;
      return token;
    },
    async session({ session, token }) {
      // session.user.id alanını JWT'den doldur
      (session.user as any).id = (token as any).id ?? token.sub ?? null;
      return session;
    },
  },
  // pages: { signIn: "/signin" },
};