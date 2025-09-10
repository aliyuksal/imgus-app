// app/api/jobs/quick/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { presignGetUrl, putBuffer, s3KeyResult } from "@/lib/s3";
import { fal } from "@fal-ai/client";

export const runtime = "nodejs";

const Body = z.object({
  prompt: z.string().trim().min(1),
  input_image_ids: z.array(z.string().min(1)).min(1).max(4),
  num_images: z.number().int().positive().max(4).default(1),
  output_format: z.enum(["jpeg", "png"]).default("jpeg"),
});

type FalImage = { url: string; content_type?: string; file_name?: string };

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const uid = (session as any)?.user?.id;
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const { prompt, input_image_ids, num_images, output_format } = parsed.data;

  // 1) input doğrula
  const inputs = await prisma.image.findMany({
    where: { id: { in: input_image_ids }, userId: uid, kind: "input" },
    select: { id: true, s3Key: true },
  });
  if (inputs.length !== input_image_ids.length) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  // 2) job oluştur (UI’da ve DB’de iz bırakmak için)
  const job = await prisma.job.create({
    data: { userId: uid, prompt, status: "running", startedAt: new Date() },
    select: { id: true, userId: true },
  });
  await Promise.all(
    inputs.map((im, idx) =>
      prisma.jobImage.create({ data: { jobId: job.id, imageId: im.id, role: "input", orderIdx: idx } })
    )
  );

  // 3) FAL’a hazırlan: presigned GET’ler
  const image_urls: string[] = [];
  for (const im of inputs) {
    image_urls.push(await presignGetUrl({ key: im.s3Key, expiresIn: 600 }));
  }

  try {
    // 4) FAL SENKRON çağrı (subscribe) — webhook yok
    const res = await fal.subscribe("fal-ai/nano-banana/edit", {
      input: { prompt, image_urls, num_images, output_format },
      // logs: true,
    });

    const images = (res?.data?.images ?? []) as FalImage[];
    if (!images.length) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "failed",
          errorCode: "no_images",
          errorMessage: JSON.stringify(res?.data ?? {}),
          finishedAt: new Date(),
        },
      });
      return NextResponse.json({ error: "No images in response" }, { status: 502 });
    }

    // 5) indir → S3/results → DB
    const outIds: string[] = [];
    const outUrls: string[] = [];

    for (let i = 0; i < images.length; i++) {
      const im = images[i];
      const r = await fetch(im.url);
      if (!r.ok) throw new Error(`download failed: ${im.url}`);
      const buf = Buffer.from(await r.arrayBuffer());

      const isPng = (im.content_type ?? "").includes("png");
      const ext = isPng ? "png" : "jpg";
      const key = s3KeyResult(job.userId, job.id, i, ext);
      await putBuffer(key, buf, im.content_type ?? (isPng ? "image/png" : "image/jpeg"));

      const out = await prisma.image.create({
        data: { userId: job.userId, kind: "output", s3Key: key, size: buf.length, mime: im.content_type ?? null },
        select: { id: true, s3Key: true },
      });
      outIds.push(out.id);
      outUrls.push(await presignGetUrl({ key: out.s3Key, expiresIn: 600 }));

      await prisma.jobImage.create({
        data: { jobId: job.id, imageId: out.id, role: "output", orderIdx: i },
      });
    }

    await prisma.job.update({
      where: { id: job.id },
      data: { status: "succeeded", finishedAt: new Date() },
    });

    // 6) istemciye ANINDA gösterim için URL’leri de dön
    return NextResponse.json({ jobId: job.id, outputs: outIds, previewUrls: outUrls }, { status: 200 });
  } catch (err: any) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        errorCode: "fal_subscribe_error",
        errorMessage: String(err?.message ?? err),
        finishedAt: new Date(),
      },
    });
    return NextResponse.json({ error: "Fal error", detail: String(err?.message ?? err) }, { status: 500 });
  }
}