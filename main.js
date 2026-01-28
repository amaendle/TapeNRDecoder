const fileEl = document.getElementById("file");
const startBtn = document.getElementById("start");
const audioEl = document.getElementById("player");
const downloadBtn = document.getElementById("download");
const statusEl = document.getElementById("status");

const modeEl = document.getElementById("mode");
const amountEl = document.getElementById("amount");
const emphasisEl = document.getElementById("emphasis");
const thresholdEl = document.getElementById("threshold");
const attackEl = document.getElementById("attack");
const releaseEl = document.getElementById("release");

const amountVal = document.getElementById("amountVal");
const emphasisVal = document.getElementById("emphasisVal");
const thresholdVal = document.getElementById("thresholdVal");
const attackVal = document.getElementById("attackVal");
const releaseVal = document.getElementById("releaseVal");

function syncLabels() {
  amountVal.textContent = Number(amountEl.value).toFixed(3);
  emphasisVal.textContent = Number(emphasisEl.value).toFixed(3);
  thresholdVal.textContent = `${Number(thresholdEl.value).toFixed(1)} dB`;
  attackVal.textContent = `${Number(attackEl.value).toFixed(1)} ms`;
  releaseVal.textContent = `${Number(releaseEl.value).toFixed(0)} ms`;
}
["input", "change"].forEach(evt => {
  amountEl.addEventListener(evt, syncLabels);
  emphasisEl.addEventListener(evt, syncLabels);
  thresholdEl.addEventListener(evt, syncLabels);
  attackEl.addEventListener(evt, syncLabels);
  releaseEl.addEventListener(evt, syncLabels);
});
syncLabels();

let ctx = null;
let source = null;
let workletNode = null;
let currentFile = null;

function getParams() {
  return {
    mode: modeEl.value,
    amount: Number(amountEl.value),
    emphasis: Number(emphasisEl.value),
    thresholdDb: Number(thresholdEl.value),
    attackMs: Number(attackEl.value),
    releaseMs: Number(releaseEl.value),
  };
}

function updateParams() {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: "params", ...getParams() });
}

modeEl.addEventListener("change", updateParams);
amountEl.addEventListener("input", updateParams);
emphasisEl.addEventListener("input", updateParams);
thresholdEl.addEventListener("input", updateParams);
attackEl.addEventListener("input", updateParams);
releaseEl.addEventListener("input", updateParams);

fileEl.addEventListener("change", () => {
  const f = fileEl.files?.[0];
  if (!f) return;
  currentFile = f;
  audioEl.src = URL.createObjectURL(f);
  audioEl.load();
  statusEl.textContent = "";
});

startBtn.addEventListener("click", async () => {
  if (ctx) return;

  ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("./dolby-worklet.js");

  source = ctx.createMediaElementSource(audioEl);

  workletNode = new AudioWorkletNode(ctx, "dolby-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  source.connect(workletNode).connect(ctx.destination);

  updateParams();
  await ctx.resume();
});

// ------------------------------
// Offline render + WAV download
// ------------------------------

downloadBtn.addEventListener("click", async () => {
  try {
    if (!currentFile) {
      statusEl.textContent = "Choose an audio file first.";
      return;
    }

    const params = getParams();
    if (params.mode === "bypass") {
      statusEl.textContent = "Mode is Bypass — choose Encode or Decode to render processed audio.";
      return;
    }

    statusEl.textContent = "Decoding audio…";
    const arrayBuffer = await currentFile.arrayBuffer();

    // Use a temporary AudioContext just for decoding (decodeAudioData lives here)
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
    await decodeCtx.close();

    statusEl.textContent = "Processing…";

    const processed = processBufferDolby(audioBuffer, params);

    statusEl.textContent = "Encoding WAV…";
    const wavBytes = audioBufferToWav16(processed);

    const blob = new Blob([wavBytes], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);

    const base = (currentFile.name || "audio").replace(/\.[^/.]+$/, "");
    const outName = `${base}.${params.mode}.wav`;

    const a = document.createElement("a");
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    statusEl.textContent = `Downloaded: ${outName}`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err?.message || err}`;
  }
});

// ------------------------------
// DSP (same shape as worklet)
// ------------------------------

class OnePoleHPF {
  constructor() {
    this.x1 = 0;
    this.y1 = 0;
  }
  process(x, a) {
    const y = a * (this.y1 + x - this.x1);
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

function dbToLin(db) {
  return Math.pow(10, db / 20);
}

function softClip(x) {
  return Math.tanh(x);
}

function processBufferDolby(audioBuffer, params) {
  const sr = audioBuffer.sampleRate;
  const numCh = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  // Copy into mutable Float32Arrays
  const ins = [];
  for (let ch = 0; ch < numCh; ch++) {
    ins.push(audioBuffer.getChannelData(ch));
  }

  // Create output buffer
  const out = new AudioBuffer({
    length,
    numberOfChannels: numCh,
    sampleRate: sr,
  });

  // State per channel
  const hpfFixed = Array.from({ length: numCh }, () => new OnePoleHPF());
  const hpfDyn = Array.from({ length: numCh }, () => new OnePoleHPF());
  const env = new Float32Array(numCh);

  const attack = Math.max(0.1, params.attackMs) / 1000;
  const release = Math.max(1, params.releaseMs) / 1000;
  const atkCoeff = Math.exp(-1 / (sr * attack));
  const relCoeff = Math.exp(-1 / (sr * release));
  const thr = dbToLin(params.thresholdDb);

  const fixedCutHz = 500;
  const rcFixed = 1 / (2 * Math.PI * fixedCutHz);
  const dt = 1 / sr;
  const aFixed = rcFixed / (rcFixed + dt);

  const minCut = 1000;
  const maxCut = 8000;

  const k = (15 / 18) * params.amount;

  for (let ch = 0; ch < numCh; ch++) {
    const inCh = ins[ch];
    const outCh = out.getChannelData(ch);

    let e = env[ch];

    for (let i = 0; i < length; i++) {
      const x = inCh[i];

      // sidepath
      let side = hpfFixed[ch].process(x, aFixed);

      const absSide = Math.abs(side);
      if (absSide > e) e = atkCoeff * e + (1 - atkCoeff) * absSide;
      else e = relCoeff * e + (1 - relCoeff) * absSide;

      const over = Math.max(0, (e - thr) / (thr + 1e-12));
      const ctrl = 1 / (1 + 4 * over);

      const cut = minCut + (maxCut - minCut) * Math.min(1, Math.max(0, ctrl * params.emphasis));
      const rcDyn = 1 / (2 * Math.PI * cut);
      const aDyn = rcDyn / (rcDyn + dt);

      side = hpfDyn[ch].process(side, aDyn);
      side = softClip(side);

      let y = (params.mode === "encode") ? (x + k * side) : (x - k * side);

      // clamp
      if (y > 1) y = 1;
      if (y < -1) y = -1;

      outCh[i] = y;
    }

    env[ch] = e;
  }

  return out;
}

// ------------------------------
// WAV encoder (16-bit PCM)
// ------------------------------

function audioBufferToWav16(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const length = buffer.length;

  // Interleave
  const interleaved = new Float32Array(length * numCh);
  const chans = [];
  for (let ch = 0; ch < numCh; ch++) chans.push(buffer.getChannelData(ch));

  let idx = 0;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      interleaved[idx++] = chans[ch][i];
    }
  }

  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const byteRate = sr * blockAlign;
  const dataSize = interleaved.length * bytesPerSample;
  const bufferSize = 44 + dataSize;

  const ab = new ArrayBuffer(bufferSize);
  const view = new DataView(ab);

  function writeString(off, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  }

  // RIFF header
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");

  // fmt chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);      // PCM fmt chunk size
  view.setUint16(20, 1, true);       // Audio format = PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);      // bits per sample

  // data chunk
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < interleaved.length; i++) {
    let s = interleaved[i];
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return ab;
}
