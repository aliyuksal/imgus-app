// app/api/uploads/commit/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { s3, S3_BUCKET } from "@/lib/s3";
import { HeadObjectCommand } from "@aws-sdk/client-s3";

export const runtime = "nodejs";

const Body = z.object({
  s3Key: z.string().min(10),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  mime: z.string().optional(),
  sizeBytes: z.number().int().positive().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const uid = (session as any)?.user?.id;
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const { s3Key, width, height, mime: m, sizeBytes } = parsed.data;

  // Sahiplik koruması
  if (!s3Key.includes(`/users/${uid}/uploads/`)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // S3 Head ile doğrula
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
  } catch {
    return NextResponse.json({ error: "Object not found" }, { status: 404 });
  }
  const mime = m ?? (head.ContentType as string | undefined);
  const size =
    sizeBytes ?? (typeof head.ContentLength === "number" ? Number(head.ContentLength) : undefined);

  // ⚠️ Şema notu: Model adların farklıysa değiştir (image -> images gibi)
  try {
    const img = await prisma.image.create({
      data: {
        userId: uid,
        kind: "input",   // enum ise: ImageKind.input
        s3Key: s3Key,
        mime: mime,
        size: size,
        width: width ?? null,
        height: height ?? null,
      },
      select: { id: true, s3Key: true, mime: true, size: true, createdAt: true },
    });

    return NextResponse.json(img, { status: 200 });
  } catch (e: any) {
    if (e?.code === "P2002") return NextResponse.json({ error: "Already committed" }, { status: 409 });
    console.error("commit_error", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}