// app/api/webhooks/fal/route.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyFalWebhook } from "@/lib/fal-webhook-verify";
import { prisma } from "@/lib/prisma";
import { putBuffer, s3KeyResult } from "@/lib/s3";

export const runtime = "nodejs";

type FalImage = {
  url: string;
  content_type?: string;
  file_name?: string;
};

function nowISO() {
  return new Date().toISOString();
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let raw: Buffer | undefined;
  let requestIdFromHeader = req.headers.get("x-fal-webhook-request-id") || undefined;

  try {
    // 1) RAW body al (imza için şart)
    const arr = await req.arrayBuffer();
    raw = Buffer.from(arr);

    // 2) İmza doğrulama (lokalde debug için skip bayrağı)
    const skipVerify = process.env.FAL_WEBHOOK_SKIP_VERIFY === "1";
    let verified = true;
    if (!skipVerify) {
      verified = await verifyFalWebhook(req, raw);
    }
    if (!verified) {
      console.error("[fal-webhook] invalid signature", {
        at: nowISO(),
        reqId: requestIdFromHeader,
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // 3) JSON parse
    let data: any;
    try {
      data = JSON.parse(raw.toString("utf-8"));
    } catch (e: any) {
      console.error("[fal-webhook] json parse error", {
        at: nowISO(),
        err: String(e?.message ?? e),
        bodySample: raw.toString("utf-8").slice(0, 300),
      });
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    // Beklenen: { request_id, status: "OK" | "ERROR", payload?: { images?: FalImage[] }, error?: any }
    const requestId: string | undefined = data?.request_id ?? requestIdFromHeader;
    requestIdFromHeader = requestIdFromHeader ?? requestId;

    if (!requestId) {
      console.error("[fal-webhook] missing request_id", { at: nowISO(), hdr: requestIdFromHeader });
      return NextResponse.json({ error: "missing_request_id" }, { status: 400 });
    }

    // 4) Job bul
    const job = await prisma.job.findFirst({
      where: { falRequestId: requestId },
      select: { id: true, userId: true, status: true },
    });
    if (!job) {
      console.error("[fal-webhook] job not found", { at: nowISO(), requestId });
      return NextResponse.json({ error: "job_not_found" }, { status: 404 });
    }

    // Event trail (işe yarayan bir breadcrumb)
    await prisma.jobEvent.create({
      data: {
        jobId: job.id,
        type: "webhook_received",
        payload: { headers: Object.fromEntries(req.headers), requestId, status: data?.status },
      },
    });

    // 5) Hata durumu
    if (data?.status !== "OK") {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "failed",
          errorCode: String(data?.error?.code ?? "fal_error"),
          errorMessage: JSON.stringify(data?.error ?? data?.payload ?? {}),
          finishedAt: new Date(),
        },
      });
      await prisma.jobEvent.create({
        data: { jobId: job.id, type: "error", payload: data },
      });

      console.warn("[fal-webhook] job failed", { at: nowISO(), requestId, jobId: job.id });
      return NextResponse.json({ ok: true, failed: true });
    }

    // 6) Görselleri indir + S3’e yaz + DB’ye kaydet
    const images = (data?.payload?.images ?? []) as FalImage[];
    if (!Array.isArray(images) || images.length === 0) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "failed",
          errorCode: "no_images",
          errorMessage: JSON.stringify(data?.payload ?? {}),
          finishedAt: new Date(),
        },
      });
      await prisma.jobEvent.create({
        data: { jobId: job.id, type: "error", payload: { reason: "no_images", data } },
      });

      console.warn("[fal-webhook] no images in payload", { at: nowISO(), requestId, jobId: job.id });
      return NextResponse.json({ ok: true, failed: true, reason: "no_images" });
    }

    const createdImageIds: string[] = [];
    let idx = 0;

    for (const im of images) {
      // indirme timeout’u (savunma amaçlı)
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 30_000); // 30s
      let res: Response;

      try {
        res = await fetch(im.url, { signal: ac.signal });
      } catch (err: any) {
        clearTimeout(timeout);
        console.error("[fal-webhook] download error", {
          at: nowISO(),
          url: im?.url,
          err: String(err?.message ?? err),
        });
        throw new Error("download_failed");
      }
      clearTimeout(timeout);

      if (!res.ok) {
        console.error("[fal-webhook] download non-200", {
          at: nowISO(),
          url: im?.url,
          status: res.status,
        });
        throw new Error(`download_http_${res.status}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());

      const isPng = (im.content_type ?? "").includes("png");
      const ext = isPng ? "png" : "jpg";
      const key = s3KeyResult(job.userId, job.id, idx, ext);

      await putBuffer(key, buf, im.content_type ?? (isPng ? "image/png" : "image/jpeg"));

      const out = await prisma.image.create({
        data: {
          userId: job.userId,
          kind: "output",
          s3Key: key,
          size: buf.length,
          mime: im.content_type ?? null,
        },
        select: { id: true },
      });
      createdImageIds.push(out.id);

      await prisma.jobImage.create({
        data: { jobId: job.id, imageId: out.id, role: "output", orderIdx: idx },
      });

      await prisma.jobEvent.create({
        data: {
          jobId: job.id,
          type: "image_saved",
          payload: { index: idx, s3Key: key, size: buf.length, mime: im.content_type ?? null },
        },
      });

      idx += 1;
    }

    // 7) Job success
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "succeeded", finishedAt: new Date() },
    });

    await prisma.jobEvent.create({
      data: { jobId: job.id, type: "success", payload: { images: images.length } },
    });

    const dt = Date.now() - t0;
    console.log("[fal-webhook] success", { at: nowISO(), requestId, jobId: job.id, images: images.length, ms: dt });

    return NextResponse.json({ ok: true, outputs: createdImageIds }, { status: 200 });
  } catch (err: any) {
    // Genel hata yakalayıcı
    console.error("[fal-webhook] unhandled error", {
      at: nowISO(),
      reqId: requestIdFromHeader,
      err: String(err?.message ?? err),
    });

    // Job id’si bilinmiyorsa yapılacak bir şey yok; biliniyorsa fail’e çekmeye çalış
    try {
      const body = raw ? JSON.parse(raw.toString("utf-8")) : null;
      const requestId = body?.request_id ?? requestIdFromHeader ?? null;

      if (requestId) {
        const job = await prisma.job.findFirst({
          where: { falRequestId: requestId },
          select: { id: true },
        });
        if (job) {
          await prisma.job.update({
            where: { id: job.id },
            data: {
              status: "failed",
              errorCode: "webhook_unhandled_error",
              errorMessage: String(err?.message ?? err),
              finishedAt: new Date(),
            },
          });
          await prisma.jobEvent.create({
            data: {
              jobId: job.id,
              type: "error",
              payload: { reason: "unhandled_error", message: String(err?.message ?? err) },
            },
          });
        }
      }
    } catch {
      // secondary error swallow
    }

    // Fal tarafında retry’a gerek yok → 200 dönebiliriz ama debug için 500 daha görünür.
    return NextResponse.json({ ok: false, error: "unhandled_error" }, { status: 500 });
  }
}