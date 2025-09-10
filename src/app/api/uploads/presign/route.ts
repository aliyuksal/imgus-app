// app/api/uploads/presign/route.ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { authOptions } from "@/lib/auth";
import { presignPutUrl } from "@/lib/s3";

export const runtime = "nodejs";

const Body = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
});

const ALLOWED = /^image\/(jpe?g|png|webp)$/i;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const uid = (session as any)?.user?.id;
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const { fileName, mimeType } = parsed.data;

  if (!ALLOWED.test(mimeType)) {
    return NextResponse.json({ error: "Unsupported MIME" }, { status: 400 });
  }

  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const env = process.env.NODE_ENV === "production" ? "prod" : "dev";

  const key = `${env}/users/${uid}/uploads/${yyyy}/${mm}/${randomUUID()}.${ext}`;
  const { uploadUrl } = await presignPutUrl({ key, contentType: mimeType, expiresIn: 300 });

  return NextResponse.json({ url: uploadUrl, s3Key: key });
}