// A “Dolby-ish” encoder/decoder inspired by the structure of the Pascal code:
// - Sidepath: HPF + dynamic emphasis controlled by envelope follower
// - Soft clip in sidepath (diode-ish overshoot)
// - Mix: encode adds sidepath, decode subtracts it (k ~= 15/18 from Mixers.Lib)

class OnePoleHPF {
  constructor() {
    this.x1 = 0;
    this.y1 = 0;
  }
  // alpha for HPF in "y = a*(y + x - x1)" form
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

// Soft clip (diode-ish). Tanh is simple + stable.
function softClip(x) {
  // Keep it gentle; sidepath should saturate a little without killing transients.
  return Math.tanh(x);
}

class DolbyProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // per-channel state
    this.hpfFixed = [new OnePoleHPF(), new OnePoleHPF()];
    this.hpfDyn = [new OnePoleHPF(), new OnePoleHPF()];
    this.env = [0, 0];

    this.params = {
      mode: "bypass",
      amount: 1.0,
      emphasis: 1.0,
      thresholdDb: -35,
      attackMs: 5,
      releaseMs: 120,
    };

    this.port.onmessage = (e) => {
      if (e.data?.type === "params") {
        this.params = { ...this.params, ...e.data };
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const numCh = Math.min(output.length, input.length);
    const n = input[0].length;

    // Convert ms to per-sample smoothing coefficients (simple one-pole)
    const attack = Math.max(0.1, this.params.attackMs) / 1000;
    const release = Math.max(1, this.params.releaseMs) / 1000;
    const atkCoeff = Math.exp(-1 / (sampleRate * attack));
    const relCoeff = Math.exp(-1 / (sampleRate * release));

    const thr = dbToLin(this.params.thresholdDb);

    // Fixed HPF: roughly "tape hiss band entry". You can tune this.
    // Higher alpha => higher cutoff. We'll compute alpha from a cutoff.
    const fixedCutHz = 500; // reasonable “sidepath highpass”
    const rcFixed = 1 / (2 * Math.PI * fixedCutHz);
    const dt = 1 / sampleRate;
    const aFixed = rcFixed / (rcFixed + dt);

    // Dynamic HPF: moves with envelope; higher level -> lower emphasis (like Dolby)
    // We'll sweep cutoff ~ 8000 Hz down to ~ 1000 Hz as envelope rises.
    const minCut = 1000;
    const maxCut = 8000;

    const mode = this.params.mode;
    const amount = this.params.amount;
    const emphasis = this.params.emphasis;

    // Mix coefficient inspired by (15/18) from Mixers.Lib
    const k = (15 / 18) * amount;

    for (let ch = 0; ch < numCh; ch++) {
      const inCh = input[ch];
      const outCh = output[ch] || output[0]; // safety
      let env = this.env[ch];

      for (let i = 0; i < n; i++) {
        const x = inCh[i];

        if (mode === "bypass") {
          outCh[i] = x;
          continue;
        }

        // --- Sidepath ---
        // 1) Fixed HPF (like HPF1 stage)
        let side = this.hpfFixed[ch].process(x, aFixed);

        // 2) Envelope follower (gain-control-ish)
        const absSide = Math.abs(side);
        const target = absSide;
        if (target > env) env = atkCoeff * env + (1 - atkCoeff) * target;
        else env = relCoeff * env + (1 - relCoeff) * target;

        // 3) Compute control signal: below threshold -> more emphasis, above -> less
        // normalized 0..1-ish
        const over = Math.max(0, (env - thr) / (thr + 1e-12));
        const ctrl = 1 / (1 + 4 * over); // falls as level rises

        // 4) Dynamic HPF based on ctrl:
        // ctrl near 1 -> high cutoff (more HF in sidepath, more NR action)
        // ctrl near 0 -> lower cutoff (less HF action at high levels)
        const cut = minCut + (maxCut - minCut) * Math.min(1, Math.max(0, ctrl * emphasis));
        const rcDyn = 1 / (2 * Math.PI * cut);
        const aDyn = rcDyn / (rcDyn + dt);

        side = this.hpfDyn[ch].process(side, aDyn);

        // 5) Soft clip (diode-ish overshoot limiter)
        side = softClip(side);

        // --- Mix like MixersEncode/MixersDecode ---
        // Encode: x + k*side; Decode: x - k*side
        let y = (mode === "encode") ? (x + k * side) : (x - k * side);

        // Avoid nasty overs when playing hot material
        // (tape would saturate anyway)
        y = Math.max(-1, Math.min(1, y));

        outCh[i] = y;
      }

      this.env[ch] = env;
    }

    return true;
  }
}

registerProcessor("dolby-processor", DolbyProcessor);
