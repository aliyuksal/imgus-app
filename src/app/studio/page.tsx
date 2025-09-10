"use client";

import { useState } from "react";

type GalleryItem = { id: string; thumbUrl: string; createdAt: string; size: number | null };

export default function Studio() {
  const [log, setLog] = useState<string[]>([]);
  const [imageId, setImageId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>("Remove background, studio white, soft natural shadows");
  const [job, setJob] = useState<{ jobId: string; requestId?: string } | null>(null);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const push = (m: string) => setLog((x) => [m, ...x]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setBusy(true);
      setLog([]);
      setJob(null);
      setImageId(null);
      setPreviews([]);

      // 1) presign
      const pres = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type }),
      });
      const pjson = await pres.json();
      if (!pres.ok) {
        push("presign error: " + JSON.stringify(pjson));
        return;
      }
      const { url, s3Key } = pjson;

      // 2) PUT (S3)
      const put = await fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) {
        push("put failed: " + put.status + " " + put.statusText);
        return;
      }

      // 3) commit
      const com = await fetch("/api/uploads/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ s3Key, mime: file.type }),
      });
      const cjson = await com.json();
      if (!com.ok) {
        push("commit failed: " + JSON.stringify(cjson));
        return;
      }

      setImageId(cjson.id);
      push("✅ committed imageId=" + cjson.id);
    } catch (err: any) {
      push("unexpected error: " + String(err?.message ?? err));
    } finally {
      setBusy(false);
      (e.target as HTMLInputElement).value = ""; // tekrar seçilebilir olsun
    }
  }

  async function createJob() {
    if (!imageId) return;
    setBusy(true);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          input_image_ids: [imageId],
          num_images: 1,
          output_format: "jpeg",
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        push("job error: " + JSON.stringify(j));
        return;
      }
      setJob(j);
      push("🚀 job submitted: " + JSON.stringify(j));
      push("Webhook gelince sonuçlar gallery'de görünecek.");
    } catch (e: any) {
      push("job exception: " + String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function createJobQuick() {
    if (!imageId) return;
    setBusy(true);
    setPreviews([]);
    try {
      const r = await fetch("/api/jobs/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          input_image_ids: [imageId],
          num_images: 1,
          output_format: "jpeg",
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        push("quick error: " + JSON.stringify(j));
        return;
      }
      setPreviews(j.previewUrls || []);
      push("✅ quick done: " + JSON.stringify({ jobId: j.jobId, outputs: j.outputs }));
    } catch (e: any) {
      push("quick exception: " + String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshGallery() {
    try {
      const r = await fetch("/api/gallery");
      const j = await r.json();
      if (!r.ok) {
        push("gallery error: " + JSON.stringify(j));
        return;
      }
      setItems(j.items as GalleryItem[]);
      push("📸 gallery refreshed (" + (j.items?.length ?? 0) + ")");
    } catch (e: any) {
      push("gallery exception: " + String(e?.message ?? e));
    }
  }

  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <h1 className="text-2xl font-semibold">Imgus • Studio (Dev Test)</h1>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* LEFT - actions */}
          <div className="rounded-2xl p-4 bg-neutral-900 border border-neutral-800 space-y-4">
            <div className="text-sm text-neutral-300">1) Upload</div>
            <input type="file" accept="image/*" onChange={onPick} disabled={busy} />

            <div className="space-y-2">
              <div className="text-sm text-neutral-300">Prompt</div>
              <textarea
                className="w-full h-24 rounded-lg bg-neutral-800 p-2 text-sm"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the edit you want…"
              />
            </div>

            {imageId && (
              <div className="text-xs text-neutral-400">
                Last imageId: <code className="text-neutral-200">{imageId}</code>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={createJobQuick}
                disabled={!imageId || !prompt.trim() || busy}
                className="px-3 py-2 rounded-lg bg-emerald-400 text-black disabled:opacity-50"
              >
                2) Run (Quick)
              </button>

              <button
                onClick={createJob}
                disabled={!imageId || !prompt.trim() || busy}
                className="px-3 py-2 rounded-lg bg-white text-black disabled:opacity-50"
              >
                2) Create Job (Queue + Webhook)
              </button>
            </div>

            {previews.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                {previews.map((u, i) => (
                  <div key={i} className="border border-neutral-800 rounded-lg overflow-hidden">
                    <img src={u} alt={"preview-" + i} className="w-full h-40 object-cover" />
                  </div>
                ))}
              </div>
            )}

            {job && (
              <div className="text-xs text-neutral-400 space-y-1">
                <div>
                  jobId: <code className="text-neutral-200">{job.jobId}</code>
                </div>
                {job.requestId && (
                  <div>
                    requestId: <code className="text-neutral-200">{job.requestId}</code>
                  </div>
                )}
              </div>
            )}

            <div className="pt-2 border-t border-neutral-800">
              <button onClick={refreshGallery} className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700">
                Refresh Gallery
              </button>
            </div>
          </div>

          {/* RIGHT - logs */}
          <div className="rounded-2xl p-4 bg-neutral-900 border border-neutral-800">
            <div className="text-sm text-neutral-300 mb-2">Logs</div>
            <div className="text-xs space-y-1 max-h-72 overflow-auto">
              {log.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  {l}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* GALLERY */}
        {items.length > 0 && (
          <div className="rounded-2xl p-4 bg-neutral-900 border border-neutral-800">
            <div className="text-sm text-neutral-300 mb-3">Gallery</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {items.map((it) => (
                <div key={it.id} className="bg-black/30 rounded-xl overflow-hidden border border-neutral-800">
                  <img src={it.thumbUrl} alt={it.id} className="w-full h-32 object-cover" />
                  <div className="p-2 text-[11px] text-neutral-400">
                    <div>
                      ID: <code className="break-all">{it.id}</code>
                    </div>
                    <div>{new Date(it.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}