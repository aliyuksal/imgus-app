import { NextResponse } from "next/server";
import { logger } from "@/lib/log";

export async function GET() {
  logger.info({ svc: "health" }, "ok");
  return NextResponse.json({ ok: true, service: "imgus-api", ts: Date.now() });
}