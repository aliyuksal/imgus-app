// app/api/gallery/route.ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { presignGetUrl } from "@/lib/s3";

export const runtime = "nodejs";

export async function GET() {
  const session = (await getServerSession(authOptions)) as any;
  const uid = session?.user?.id;
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Son 24 output görseli
  const images = await prisma.image.findMany({
    where: { userId: uid, kind: "output" },
    orderBy: { createdAt: "desc" },
    take: 24,
  });

  const items = await Promise.all(
    images.map(async (x) => ({
      id: x.id,
      thumbUrl: await presignGetUrl({ key: x.s3Key, expiresIn: 600 }),
      createdAt: x.createdAt.toISOString(),
      size: x.size ?? null,
    }))
  );

  return NextResponse.json({ items }, { status: 200 });
}