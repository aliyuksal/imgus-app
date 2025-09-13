import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { presignGetUrl } from "@/lib/s3";
import { fal } from "@fal-ai/client";

export const runtime = "nodejs";

const Body = z.object({
  prompt: z.string().trim().min(1, "prompt is required"),
  input_image_ids: z.array(z.string().min(1)).min(1).max(4),
  num_images: z.number().int().positive().max(4).default(1),
  output_format: z.enum(["jpeg", "png"]).default("jpeg"),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const uid = (session as any)?.user?.id;
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const { prompt, input_image_ids, num_images, output_format } = parsed.data;

  // input doğrula
  const inputs = await prisma.image.findMany({
    where: { id: { in: input_image_ids }, userId: uid, kind: "input" },
    select: { id: true, s3Key: true },
  });
  if (inputs.length !== input_image_ids.length) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  // FAL'a gidecek presigned GET'ler
  const image_urls: string[] = [];
  for (const im of inputs) {
    image_urls.push(await presignGetUrl({ key: im.s3Key, expiresIn: 600 }));
  }

  // job create → queued
  const job = await prisma.job.create({
    data: { userId: uid, prompt, status: "queued" },
    select: { id: true, userId: true },
  });

  await Promise.all(
    inputs.map((im, idx) =>
      prisma.jobImage.create({ data: { jobId: job.id, imageId: im.id, role: "input", orderIdx: idx } })
    )
  );

  const webhookUrl = process.env.FAL_WEBHOOK_URL || undefined;

  try {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "running", startedAt: new Date() },
    });

    const { request_id } = await fal.queue.submit("fal-ai/nano-banana/edit", {
      input: { prompt, image_urls, num_images, output_format },
      ...(webhookUrl ? { webhookUrl } : {}), // ← opsiyonel
    });

    await prisma.job.update({
      where: { id: job.id },
      data: { falRequestId: request_id },
    });

    return NextResponse.json(
      { jobId: job.id, requestId: request_id, mode: webhookUrl ? "webhook" : "poll" },
      { status: 200 }
    );
  } catch (err: any) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        errorCode: "fal_queue_submit_error",
        errorMessage: String(err?.message ?? err),
        finishedAt: new Date(),
      },
    });
    return NextResponse.json(
      { error: "Fal queue submit failed", detail: String(err?.message ?? err) },
      { status: 502 }
    );
  }
}