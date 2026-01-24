const fileEl = document.getElementById("file");
const startBtn = document.getElementById("start");
const audioEl = document.getElementById("player");

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

function updateParams() {
  if (!workletNode) return;
  workletNode.port.postMessage({
    type: "params",
    mode: modeEl.value,
    amount: Number(amountEl.value),
    emphasis: Number(emphasisEl.value),
    thresholdDb: Number(thresholdEl.value),
    attackMs: Number(attackEl.value),
    releaseMs: Number(releaseEl.value),
  });
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
  audioEl.src = URL.createObjectURL(f);
  audioEl.load();
});

startBtn.addEventListener("click", async () => {
  if (ctx) return;

  ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("./dolby-worklet.js");

  // Use <audio> element as source, route through worklet.
  source = ctx.createMediaElementSource(audioEl);

  workletNode = new AudioWorkletNode(ctx, "dolby-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2], // stereo out
  });

  source.connect(workletNode).connect(ctx.destination);

  updateParams();

  // iOS/Safari sometimes needs a resume on user gesture
  await ctx.resume();
});
