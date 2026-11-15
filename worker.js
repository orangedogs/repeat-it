// 브라우저 안에서 Whisper(영어) 음성인식을 수행하는 웹 워커
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

env.allowLocalModels = false;

const pipes = new Map(); // key: model|device|dtype

async function gpuInfo() {
  try { const a = navigator.gpu && await navigator.gpu.requestAdapter(); return a ? { ok: true, f16: a.features.has('shader-f16') } : { ok: false }; } catch { return { ok: false }; }
}

async function getPipe(model) {
  // 그래픽 카드(WebGPU)가 있으면 그걸로, 없으면 CPU(wasm)로.
  // small은 원본(fp32)이 1GB 가까이 돼서 그래픽 카드에서는 fp16(절반 크기, 정확도 거의 같음)으로 돌림.
  // CPU용 q8(8비트 압축)은 정확도가 떨어져서 마지막 수단으로만 씀.
  const g = await gpuInfo();
  const small = model.includes('small');
  const plans = [];
  if (g.ok) plans.push(['webgpu', small ? (g.f16 ? 'fp16' : 'fp32') : 'fp32']);
  plans.push(['wasm', 'q8']);
  let lastErr;
  for (const [device, dtype] of plans) {
    const key = `${model}|${device}|${dtype}`;
    if (pipes.has(key)) return { pipe: pipes.get(key), device };
    try {
      const files = {};
      const p = await pipeline('automatic-speech-recognition', model, {
        device, dtype,
        progress_callback: (d) => {
          if (d.status === 'progress' && d.total) {
            files[d.file] = { loaded: d.loaded, total: d.total };
            const all = Object.values(files);
            const loaded = all.reduce((a, f) => a + f.loaded, 0);
            const total = all.reduce((a, f) => a + f.total, 0);
            postMessage({ type: 'download', loaded, total });
          }
        },
      });
      pipes.set(key, p);
      return { pipe: p, device };
    } catch (e) {
      lastErr = e;
      console.warn(`[worker] ${device} 로드 실패, 다음 방식 시도`, e);
    }
  }
  throw lastErr;
}

// 앱이 소리 크기로 찾아 준 '말 구간 묶음(창)'마다 받아쓴다.
// 창은 항상 말 사이 쉼에서 잘려 있어서 단어가 중간에 잘리지 않는다.
self.onmessage = async (e) => {
  const { audio, windows, model } = e.data;
  const SR = 16000;
  try {
    postMessage({ type: 'status', text: '음성인식 모델 불러오는 중…' });
    const { pipe, device } = await getPipe(model);
    postMessage({
      type: 'status', text: '음성을 인식하는 중…',
      note: device === 'webgpu' ? '그래픽 카드를 사용해 빠르게 처리하고 있어요.' : '이 브라우저에서는 그래픽 카드를 사용할 수 없어 처리 시간이 더 걸릴 수 있어요.',
    });
    postMessage({ type: 'progress', value: 0 });

    const total = windows.reduce((a, w) => a + (w.end - w.start), 0) || 1;
    let done = 0;
    const results = [];
    const n = (t) => t.split(/\s+/).filter(Boolean).length;
    const NOISE = /\[[^\]]*\]|\([^)]*\)|♪/;
    // 한 구간을 받아씀 → { text, words:[{w, s, e}] } (단어마다 실제 시작·끝 시각, 초 단위)
    const recognize = async (start, end) => {
      const off = Math.max(0, start - 0.2);
      const clip = audio.subarray(Math.floor(off * SR), Math.min(audio.length, Math.ceil((end + 0.2) * SR)));
      const dur = clip.length / SR;
      let words = [];
      try {
        const out = await pipe(clip, { return_timestamps: 'word' });
        words = (out.chunks || []).map((c) => ({ w: c.text.trim(), s: off + (c.timestamp?.[0] ?? 0), e: off + (c.timestamp?.[1] ?? c.timestamp?.[0] ?? dur) })).filter((x) => x.w);
      } catch (err) { console.warn('[worker] 단어 시각 실패', err); }
      let text = words.map((x) => x.w).join(' ');
      // 단어 결과가 비었거나 구간 끝까지 닿지 않으면 뒷부분을 빼먹었을 수 있으므로 일반 모드로 다시 받아써서 더 긴 쪽 사용
      const lastEnd = words.length ? words[words.length - 1].e - off : 0;
      if (!text || lastEnd < dur - 3) {
        const plain = ((await pipe(clip, {})).text || '').trim();
        if (n(plain) > n(text)) { text = plain; words = []; } // 단어 시각 없음 → 앱이 말 구간 기준으로 맞춤
      }
      return { text, words };
    };
    for (const w of windows) {
      const r0 = await recognize(w.start, w.end);
      if (!r0.words.length && NOISE.test(r0.text) && w.regs.length > 1) {
        // (단어 시각이 없을 때) 음악·효과음이 섞인 창은 구간마다 따로 인식해서, 말이 아닌 구간에 글자가 배정되지 않게 함
        for (const r of w.regs) results.push({ start: r.start, end: r.end, regs: [r], ...(await recognize(r.start, r.end)) });
      } else {
        results.push({ start: w.start, end: w.end, regs: w.regs, ...r0 });
      }
      done += w.end - w.start;
      postMessage({ type: 'progress', value: Math.min(1, done / total) });
    }
    postMessage({ type: 'done', results });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
