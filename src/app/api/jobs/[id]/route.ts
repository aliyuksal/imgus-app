// app/api/jobs/[id]/route.ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { putBuffer, presignGetUrl, s3KeyResult } from "@/lib/s3";
import { fal } from "@fal-ai/client";
import { $Enums } from "@prisma/client"; // ✅ Prisma 6 enum tipi

export const runtime = "nodejs";

type FalImage = { url: string; content_type?: string; file_name?: string };

// ✅ Tip-güvenli status kümeleri (DB tarafı)
const TERMINAL_STATUSES = new Set<$Enums.JobStatus>(["succeeded", "failed", "canceled"]);
const RUNNING_STATUSES = new Set<$Enums.JobStatus>(["queued", "running", "pending"]);

async function existingOutputs(jobId: string) {
  const outs = await prisma.jobImage.findMany({
    where: { jobId, role: "output" },
    include: { image: true },
    orderBy: { orderIdx: "asc" },
  });
  if (outs.length === 0) return [];
  return Promise.all(
    outs.map(async (o) => ({
      id: o.imageId,
      url: await presignGetUrl({ key: o.image.s3Key, expiresIn: 600 }),
    }))
  );
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const uid = (session as any)?.user?.id;
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.job.findFirst({
    where: { id: params.id, userId: uid },
    select: { id: true, userId: true, status: true, falRequestId: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const status = job.status as $Enums.JobStatus;

  // 1) Terminal ise mevcut outputları dön
  if (TERMINAL_STATUSES.has(status)) {
    const outputs = await existingOutputs(job.id);
    return NextResponse.json({ jobId: job.id, status, outputs }, { status: 200 });
  }

  // 2) DB'de output varsa succeeded'e çek ve dön
  const pre = await existingOutputs(job.id);
  if (pre.length > 0) {
    if (status !== "succeeded") {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "succeeded", finishedAt: new Date() },
      });
    }
    return NextResponse.json({ jobId: job.id, status: "succeeded", outputs: pre }, { status: 200 });
  }

  // 3) FAL kuyruğu durumunu yokla
  try {
    if (!job.falRequestId) {
      return NextResponse.json({ jobId: job.id, status, outputs: [] }, { status: 200 });
    }

    // SDK’nin tip union’ı: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED"  (bazı sürümlerde yalnızca bu üçü)
    const q = await fal.queue.status("fal-ai/nano-banana/edit", { requestId: job.falRequestId });
    const qStatus = (q?.status ?? "IN_QUEUE") as "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";

    if (qStatus === "IN_QUEUE" || qStatus === "IN_PROGRESS") {
      // hâlâ çalışıyor
      if (!RUNNING_STATUSES.has(status)) {
        await prisma.job.update({ where: { id: job.id }, data: { status: "running", startedAt: new Date() } });
      }
      return NextResponse.json({ jobId: job.id, status: "running", outputs: [] }, { status: 200 });
    }

    // qStatus === "COMPLETED" → sonucu al, indir → S3 → DB
    const res = await fal.queue.result("fal-ai/nano-banana/edit", { requestId: job.falRequestId });
    const images = (res?.data?.images ?? []) as FalImage[];

    if (!images.length) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "failed",
          errorCode: "no_images",
          errorMessage: "FAL result has no images",
          finishedAt: new Date(),
        },
      });
      return NextResponse.json({ jobId: job.id, status: "failed", outputs: [] }, { status: 200 });
    }

    const outIds: string[] = [];
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

      await prisma.jobImage.create({
        data: { jobId: job.id, imageId: out.id, role: "output", orderIdx: i },
      });
    }

    await prisma.job.update({
      where: { id: job.id },
      data: { status: "succeeded", finishedAt: new Date() },
    });

    const outputs = await Promise.all(
      outIds.map(async (id) => {
        const im = await prisma.image.findUniqueOrThrow({ where: { id }, select: { s3Key: true } });
        return { id, url: await presignGetUrl({ key: im.s3Key, expiresIn: 600 }) };
      })
    );

    return NextResponse.json({ jobId: job.id, status: "succeeded", outputs }, { status: 200 });
  } catch (err: any) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        errorCode: "poll_error",
        errorMessage: String(err?.message ?? err),
        finishedAt: new Date(),
      },
    });
    return NextResponse.json(
      { jobId: job.id, status: "failed", error: String(err?.message ?? err) },
      { status: 200 }
    );
  }
}