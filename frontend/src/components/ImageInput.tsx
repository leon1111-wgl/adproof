import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, ImagePlus, X } from "lucide-react";
import type { ImagePayload } from "../demo";
import { DOWNLOAD_BYTES, LoadError, PINS } from "../ocr/engine";
import { buildDocument, type OcrImage } from "../ocr/layout";
import measured from "../ocr/measured.json";
import { canRun, engineLoaded, getEngine, IMAGE_TYPES, MAX_BYTES, MAX_IMAGES, ocrBlob } from "../ocr/run";

interface Item { id: number; name: string; blob: Blob; url: string }
interface Done { image: OcrImage; seconds: number }
interface ExampleSet { id: string; label: string; files: string[]; note: string }

const MB = (n: number) => (n / 1e6).toFixed(1);
const BASE = import.meta.env.BASE_URL;
let nextId = 1;

const LOAD_TEXT: Record<LoadError["code"], string> = {
  http: "下载失败（服务器返回错误）",
  network: "网络中断",
  hash: "文件校验不符（大小或 SHA-256 与固定版本不一致），已拒绝运行",
  runtime: "运行时没能启动",
  cancelled: "已取消",
};

const NO_RUN: Record<string, string> = {
  no_wasm: "这个浏览器不支持 WebAssembly",
  no_simd: "这个浏览器不支持 WebAssembly SIMD",
  insecure: "页面不在安全上下文中（无法校验文件哈希）",
  no_canvas: "这个浏览器不支持图片解码",
};

const M = measured as { run_id: number; char_accuracy: number; total_retention: number; retained: string; images: number; small_print_smallest_tested_px: number; latency_p95_seconds: Record<string, number> };
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The measured result, with its run, so a visitor can tell what the numbers are (docs/EVALUATION.md 8.3). */
export function OcrEvidence() {
  return (
    <p className="faint ocr-evidence-line">
      评测（SYNTHETIC 渲染的字幕帧和海报 {M.images} 张，冻结后只跑一次，
      <a href={`https://github.com/leon1111-wgl/adproof/actions/runs/${M.run_id}`} target="_blank" rel="noreferrer">运行 {M.run_id}</a>）：
      字符准确率 {pct1(M.char_accuracy)}，与直接粘贴文字相比保留 {pct1(M.total_retention)} 的问题（{M.retained}）。真实广告更难，这些数字不代表真实素材上的表现。
    </p>
  );
}

/** What OCR does not see. Shown before and after recognition, and repeated in the review's scope. */
export function OcrLimits() {
  return (
    <div className="ocr-limits" role="note">
      <b>OCR 看不到的</b>
      <ul>
        <li><b>说出来的话</b>：口播、配音不在画面上；请同时附上字幕文件或粘贴口播稿。</li>
        <li><b>小字</b>：合成评测只测到 {M.small_print_smallest_tested_px} px（清晰的白底截图）；更小、低对比度或压缩过的角标和免责声明可能漏识或识别错，置信度低的行会标黄。</li>
        <li><b>画面本身</b>：前后对比图、白大褂、徽章、奖杯图标等视觉暗示不审查，只有文字进入规则引擎。</li>
        <li><b>竖排、弧形、艺术字和倾斜文字</b>：检测器只处理水平文字，可能整段漏掉。</li>
      </ul>
    </div>
  );
}

/** A recognised image with its line boxes (amber = low confidence). */
export function OcrFigure({ index, url, image, seconds }: { index: number; url: string; image: OcrImage; seconds?: number }) {
  const low = PINS.postprocess.low_confidence;
  return (
    <figure className="ocr-figure">
      <div className="ocr-frame">
        <img src={url} alt={`图 ${index + 1}：${image.name}`} />
        <svg viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="none" aria-hidden="true">
          {image.lines.map((l, i) => (
            <rect key={i} className={l.conf < low ? "ocr-line low" : "ocr-line"} x={l.box.x0} y={l.box.y0} width={l.box.x1 - l.box.x0} height={l.box.y1 - l.box.y0} />
          ))}
        </svg>
      </div>
      <figcaption className="faint">
        图 {index + 1} · {image.name} · {image.lines.length} 行{seconds !== undefined ? ` · ${seconds.toFixed(1)} 秒` : ""}
      </figcaption>
    </figure>
  );
}

export default function ImageInput({ onChange }: { onChange: (payload: ImagePayload | null) => void }) {
  const support = useMemo(() => canRun(), []);
  const [items, setItems] = useState<Item[]>([]);
  const [done, setDone] = useState<Record<number, Done>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(engineLoaded() ? "ready" : "idle");
  const [progress, setProgress] = useState<{ loaded: number; file: string }>({ loaded: 0, file: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState<number | null>(null);
  const [srt, setSrt] = useState<{ name: string; text: string } | null>(null);
  const [examples, setExamples] = useState<ExampleSet[]>([]);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const srtInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${BASE}ocr-examples/index.json`)
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : { sets: [] }))
      .then((d: { sets: ExampleSet[] }) => setExamples(d.sets ?? []))
      .catch(() => setExamples([]));
  }, []);

  // Object URLs are not revoked: a review submitted from this tab keeps showing its images.

  // recognise whatever is not recognised yet, once the engine is there
  useEffect(() => {
    if (status !== "ready" || working !== null) return;
    const next = items.find((i) => !done[i.id]);
    if (!next) return;
    let live = true;
    setWorking(next.id);
    getEngine(() => undefined, new AbortController().signal)
      .then((e) => ocrBlob(e, next.name, next.blob))
      .then((r) => { if (live) setDone((d) => ({ ...d, [next.id]: r })); })
      .catch((e) => { if (live) setMessage(`图片「${next.name}」识别失败：${e instanceof Error ? e.message : String(e)}`); setItems((xs) => xs.filter((x) => x.id !== next.id)); })
      .finally(() => { if (live) setWorking(null); });
    return () => { live = false; };
  }, [status, items, done, working]);

  // the payload for the review: only when every image is recognised
  useEffect(() => {
    const all = items.length > 0 && items.every((i) => done[i.id]);
    if (!all) {
      onChange(null);
      return;
    }
    const images = items.map((i) => done[i.id].image);
    onChange({
      document: buildDocument(images),
      images: items.map((i, k) => ({ name: i.name, width: images[k].width, height: images[k].height, url: i.url })),
      srt: srt?.text,
      seconds: items.map((i) => done[i.id].seconds),
    });
  }, [items, done, srt, onChange]);

  function add(files: { name: string; blob: Blob }[], replace = false) {
    setMessage(null);
    const room = MAX_IMAGES - (replace ? 0 : items.length);
    const ok = files.filter((f) => IMAGE_TYPES.includes(f.blob.type) && f.blob.size <= MAX_BYTES);
    const skipped = files.length - ok.length + Math.max(0, ok.length - room);
    if (skipped > 0) setMessage(`有 ${skipped} 个文件没有加入：只接受 PNG / JPEG / WebP，每张不超过 15 MB，最多 ${MAX_IMAGES} 张。`);
    const added = ok.slice(0, Math.max(0, room)).map((f) => ({ id: nextId++, name: f.name, blob: f.blob, url: URL.createObjectURL(f.blob) }));
    setItems((xs) => (replace ? added : [...xs, ...added]));
  }

  function remove(id: number) {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }

  async function loadExample(set: ExampleSet) {
    setMessage(null);
    try {
      const blobs = await Promise.all(set.files.map(async (f) => {
        const r = await fetch(`${BASE}ocr-examples/${f}`);
        if (!r.ok) throw new Error(`${f}: ${r.status}`);
        return { name: f, blob: await r.blob() };
      }));
      setDone({});
      add(blobs, true);
    } catch (e) {
      setMessage(`示例图片没能加载：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function load() {
    const controller = new AbortController();
    abort.current = controller;
    setStatus("loading");
    setMessage(null);
    setProgress({ loaded: 0, file: "" });
    try {
      await getEngine((loaded, _total, file) => setProgress({ loaded, file }), controller.signal);
      setStatus("ready");
    } catch (e) {
      setStatus(e instanceof LoadError && e.code === "cancelled" ? "idle" : "error");
      setMessage(e instanceof LoadError ? `OCR 模型没有加载：${LOAD_TEXT[e.code]}${e.file ? `（${e.file}）` : ""}。粘贴文字和上传字幕不受影响。` : String(e));
    } finally {
      abort.current = null;
    }
  }

  function onSrt(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSrt({ name: file.name, text: String(reader.result ?? "") });
    reader.readAsText(file, "utf-8");
  }

  if (!support.ok) {
    return (
      <div className="stack" style={{ gap: 10 }}>
        <div className="notice" data-testid="ocr-unsupported">{NO_RUN[support.reason]}，图片识别不可用。可以粘贴口播文案或上传 SRT 字幕。</div>
        <OcrLimits />
      </div>
    );
  }

  const pending = items.filter((i) => !done[i.id]).length;
  const doc = items.length && !pending ? buildDocument(items.map((i) => done[i.id].image)) : null;
  const lowLines = doc?.lines.filter((l) => l.low) ?? [];

  return (
    <div className="stack ocr-input" style={{ gap: 12 }}>
      <div className="row row-wrap" style={{ gap: 8 }}>
        <button className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={items.length >= MAX_IMAGES}><ImagePlus size={14} /> 选择图片</button>
        <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden data-testid="ocr-files"
          onChange={(e) => { add([...(e.target.files ?? [])].map((f) => ({ name: f.name, blob: f }))); e.target.value = ""; }} />
        <button className="btn btn-sm" onClick={() => srtInput.current?.click()}><FileUp size={14} /> {srt ? `字幕：${srt.name}` : "附上 .srt（可选）"}</button>
        <input ref={srtInput} type="file" accept=".srt,text/plain" hidden onChange={(e) => onSrt(e.target.files?.[0])} />
        {srt && <button className="btn btn-sm" onClick={() => setSrt(null)} aria-label="去掉字幕文件"><X size={14} /></button>}
        <span className="spacer" />
        {examples.map((s) => <button key={s.id} className="btn btn-sm" onClick={() => loadExample(s)} title={s.note}>示例：{s.label}</button>)}
      </div>
      <div
        className="ocr-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); add([...e.dataTransfer.files].map((f) => ({ name: f.name, blob: f }))); }}
      >
        拖入或选择广告截图、海报或几张视频帧（PNG / JPEG / WebP，最多 {MAX_IMAGES} 张，每张不超过 15 MB），按选择的顺序审查。图片只在本页处理，不上传。
        {srt && <> 附上的字幕排在图片文字前面，问题会标出字幕时间；如果画面上的字幕就是这份字幕，同一句会算两次。</>}
      </div>

      {status !== "ready" && (
        <div className="ocr-model" data-testid="ocr-model">
          <div>
            <b>识别图中文字需要先下载 OCR 模型</b>
            <p className="faint">
              PP-OCRv5 mobile 检测 + 识别（PaddlePaddle，Apache-2.0）{MB(PINS.weights.files["ch_PP-OCRv5_det.onnx"].bytes)} + {MB(PINS.weights.files["ch_PP-OCRv5_rec.onnx"].bytes)} MB，
              onnxruntime-web {PINS.runtime.version} 运行时 {MB(PINS.runtime.files["ort-wasm-simd-threaded.wasm"].bytes)} MB，共 {MB(DOWNLOAD_BYTES)} MB。
              权重从本站加载，运行时来自 jsDelivr，每个文件都校验大小和 SHA-256，不符就拒绝运行；在本页用 WebAssembly 单线程运行，不用 GPU。
              识别出的繁体字按 OpenCC 字表转成简体再审查（规则按简体编写）。
            </p>
          </div>
          {status === "loading" ? (
            <div className="ocr-progress">
              <progress max={DOWNLOAD_BYTES} value={progress.loaded} aria-label="下载进度" />
              <span className="faint mono">{progress.file || "连接中"} · {MB(progress.loaded)} / {MB(DOWNLOAD_BYTES)} MB</span>
              <button className="btn btn-sm" onClick={() => abort.current?.abort()}>取消</button>
            </div>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={load} data-testid="ocr-load">下载并启用识别（{MB(DOWNLOAD_BYTES)} MB）</button>
          )}
        </div>
      )}
      <OcrEvidence />
      {message && <div className="notice" role="alert">{message}</div>}

      {items.length > 0 && (
        <div className="ocr-grid">
          {items.map((item, k) => (
            <div key={item.id} className="ocr-item">
              {done[item.id] ? (
                <OcrFigure index={k} url={item.url} image={done[item.id].image} seconds={done[item.id].seconds} />
              ) : (
                <figure className="ocr-figure">
                  <div className="ocr-frame"><img src={item.url} alt={`图 ${k + 1}：${item.name}`} /></div>
                  <figcaption className="faint">图 {k + 1} · {item.name} · {working === item.id ? "识别中…" : status === "ready" ? "等待识别" : "未识别"}</figcaption>
                </figure>
              )}
              <button className="btn btn-sm ocr-remove" onClick={() => remove(item.id)} aria-label={`移除图 ${k + 1}`}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {doc && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row row-wrap" style={{ gap: 8 }}>
            <b className="small">交给审查引擎的文字</b>
            <span className="faint">{doc.text.length} 字 · {doc.lines.length} 行{lowLines.length ? ` · ${lowLines.length} 行置信度低于 ${Math.round(PINS.postprocess.low_confidence * 100)}%，可能识别错` : ""}</span>
          </div>
          <div className="ocr-text" data-testid="ocr-text">
            {doc.lines.map((l, i) => (
              <span key={i} className={l.low ? "low" : undefined} title={`图 ${l.image + 1} · 置信度 ${Math.round(l.conf * 100)}%`}>
                {l.text}{doc.text[l.end] === "\n" ? "\n" : ""}
              </span>
            ))}
          </div>
          {!doc.text.trim() && <div className="notice">图片里没有识别出文字。</div>}
        </div>
      )}
      <OcrLimits />
    </div>
  );
}
