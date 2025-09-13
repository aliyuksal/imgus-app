////src/app/studio içeriği

"use client";
import { useState } from "react";

type GalleryItem = { id: string; thumbUrl: string; createdAt: string; size: number | null };

export default function Studio() {
  const [log, setLog] = useState<string[]>([]);
  const [imageIds, setImageIds] = useState<string[]>([]);   // ← çoklu
  const [prompt, setPrompt] = useState("Remove background, studio white, soft natural shadows");
  const [job, setJob] = useState<{ jobId: string; requestId?: string } | null>(null);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const push = (m: string) => setLog((x) => [m, ...x]);

  async function uploadOne(file: File) {
    // 1) presign
    const pres = await fetch("/api/uploads/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: file.name, mimeType: file.type }),
    });
    const pjson = await pres.json();
    if (!pres.ok) throw new Error("presign error: " + JSON.stringify(pjson));
    const { url, s3Key } = pjson;

    // 2) PUT
    const put = await fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
    if (!put.ok) throw new Error("put failed: " + put.status + " " + put.statusText);

    // 3) commit
    const com = await fetch("/api/uploads/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ s3Key, mime: file.type }),
    });
    const cjson = await com.json();
    if (!com.ok) throw new Error("commit failed: " + JSON.stringify(cjson));

    return cjson.id as string; // imageId
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;

    try {
      setBusy(true);
      setLog([]);
      setJob(null);
      setPreviews([]);
      setImageIds([]);

      // en fazla 4 görsel
      const selected = files.slice(0, 4);

      const ids: string[] = [];
      for (const f of selected) {
        try {
          const id = await uploadOne(f);
          ids.push(id);
          push("✅ committed imageId=" + id);
        } catch (err: any) {
          push(String(err?.message ?? err));
        }
      }
      setImageIds(ids);
    } finally {
      setBusy(false);
      (e.target as HTMLInputElement).value = "";
    }
  }

  async function createJobQuick() {
    if (imageIds.length === 0) return;
    setBusy(true);
    setPreviews([]);
    try {
      const r = await fetch("/api/jobs/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          input_image_ids: imageIds,     // ← çoklu
          num_images: 1,
          output_format: "jpeg",
        }),
      });
      const j = await r.json();
      if (!r.ok) { push("quick error: " + JSON.stringify(j)); return; }
      setPreviews(j.previewUrls || []);
      push("✅ quick done: " + JSON.stringify({ jobId: j.jobId, outputs: j.outputs }));
    } catch (e: any) {
      push("quick exception: " + String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function createJob() {
  if (imageIds.length === 0) return;
  setBusy(true);
  try {
    const r = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        input_image_ids: imageIds,
        num_images: 1,
        output_format: "jpeg",
      }),
    });
    const j = await r.json();
    if (!r.ok) { push("job error: " + JSON.stringify(j)); return; }

    setJob(j);
    push("🚀 job submitted: " + JSON.stringify(j));

    // ---- POLLING ----
    const jobId = j.jobId as string;
    let tries = 0;
    const maxTries = 90; // ~3 dakika

    const tick = async () => {
      tries += 1;
      const s = await fetch(`/api/jobs/${jobId}`);
      const sj = await s.json();

      if (sj.status === "succeeded") {
        setPreviews(sj.outputs?.map((o: any) => o.url) || []);
        push("✅ job done");
      } else if (sj.status === "failed") {
        push("job failed: " + (sj.error || "unknown"));
      } else if (tries < maxTries) {
        setTimeout(tick, 2000);
      } else {
        push("job still running, stop polling.");
      }
    };

    setTimeout(tick, 2000);
  } catch (e: any) {
    push("job exception: " + String(e?.message ?? e));
  } finally {
    setBusy(false);
  }
}

  async function refreshGallery() {
    try {
      const r = await fetch("/api/gallery");
      const j = await r.json();
      if (!r.ok) { push("gallery error: " + JSON.stringify(j)); return; }
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
          {/* LEFT */}
          <div className="rounded-2xl p-4 bg-neutral-900 border border-neutral-800 space-y-4">
            <div className="text-sm text-neutral-300">1) Upload</div>
            <input type="file" accept="image/*" multiple onChange={onPick} disabled={busy} />

            <div className="space-y-2">
              <div className="text-sm text-neutral-300">Prompt</div>
              <textarea
                className="w-full h-24 rounded-lg bg-neutral-800 p-2 text-sm"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the edit you want…"
              />
            </div>

            {imageIds.length > 0 && (
              <div className="text-xs text-neutral-400">
                Selected imageIds:
                <ul className="list-disc pl-4">
                  {imageIds.map((id) => <li key={id}><code className="text-neutral-200">{id}</code></li>)}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={createJobQuick}
                disabled={imageIds.length === 0 || !prompt.trim() || busy}
                className="px-3 py-2 rounded-lg bg-emerald-400 text-black disabled:opacity-50"
              >
                2) Run (Quick)
              </button>
              <button
                onClick={createJob}
                disabled={imageIds.length === 0 || !prompt.trim() || busy}
                className="px-3 py-2 rounded-lg bg-white text-black disabled:opacity-50"
              >
                2) Create Job (Queue + Webhook)
              </button>
              <button
                onClick={refreshGallery}
                className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700"
              >
                Refresh Gallery
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
                <div>jobId: <code className="text-neutral-200">{job.jobId}</code></div>
                {job.requestId && <div>requestId: <code className="text-neutral-200">{job.requestId}</code></div>}
              </div>
            )}
          </div>

          {/* RIGHT – logs */}
          <div className="rounded-2xl p-4 bg-neutral-900 border border-neutral-800">
            <div className="text-sm text-neutral-300 mb-2">Logs</div>
            <div className="text-xs space-y-1 max-h-72 overflow-auto">
              {log.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)}
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
                    <div>ID: <code className="break-all">{it.id}</code></div>
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