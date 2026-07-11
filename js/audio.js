// Thin wrapper around the WebAudio-backed <audio> elements so the rest of
// the game can just call named sound events.
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.ambientSource = null;
    this.heartbeatActive = false;
    this.heartbeatTimer = null;
    this.heartbeatIntensity = 0;
    this.unlocked = false;
  }

  createContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Master boost + limiter: the source files are mastered quiet, and
    // lowering the OS/device volume is always an option, so push overall
    // level up here and lean on the compressor to keep it from clipping.
    this.master = this.ctx.createGain();
    this.master.gain.value = 2.4;
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -22;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 10;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.22;
    this.master.connect(this.compressor).connect(this.ctx.destination);
  }

  async loadSounds() {
    const files = {
      ambience: "sounds/ambience.ogg",
      heartbeat: "sounds/heartbeat.ogg",
      roar1: "sounds/roar1.ogg",
      roar2: "sounds/roar2.ogg",
      static: "sounds/static.ogg",
      chase: "sounds/chase_music.ogg",
      knock: "sounds/windowknock.ogg",
    };
    await Promise.all(
      Object.entries(files).map(async ([key, url]) => {
        const res = await fetch(url);
        const arr = await res.arrayBuffer();
        this.buffers[key] = await this.ctx.decodeAudioData(arr);
      })
    );
  }

  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  playOneShot(name, { volume = 1, pitch = 1 } = {}) {
    if (!this.buffers[name]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.playbackRate.value = pitch;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(this.master);
    src.start();
    return src;
  }

  startAmbience() {
    if (this.ambientSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.ambience;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.55;
    src.connect(gain).connect(this.master);
    src.start();
    this.ambientSource = src;
  }

  // The heartbeat clip is a single ~0.77s pulse, not audio mastered for
  // seamless looping - its start and end samples don't match, so
  // AudioBufferSourceNode's raw loop=true produced an audible click at
  // every repeat, and looping one beat back-to-back with no gap doesn't
  // read as a heartbeat rhythm anyway. Retriggering it as discrete, freshly
  // started one-shots with real silence between them - like an actual
  // pulse - fixes both: no loop seam to click on, and the *rate* of beats
  // (not just their pitch/volume) now carries the tension.
  startHeartbeatLoop() {
    if (this.heartbeatActive) return;
    this.heartbeatActive = true;
    this._scheduleNextHeartbeat();
  }

  stopHeartbeatLoop() {
    this.heartbeatActive = false;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _scheduleNextHeartbeat() {
    if (!this.heartbeatActive) return;
    // Resting ~50bpm (slow, ominous) ramping up to a racing ~150bpm at
    // max danger - deliberately past a realistic max heart rate for
    // extra tension, a common horror-audio cheat.
    const bpm = 50 + this.heartbeatIntensity * 100;
    const intervalMs = (60 / bpm) * 1000;
    this.heartbeatTimer = setTimeout(() => {
      this._playHeartbeatPulse();
      this._scheduleNextHeartbeat();
    }, intervalMs);
  }

  _playHeartbeatPulse() {
    const buffer = this.buffers.heartbeat;
    if (!buffer || this.heartbeatIntensity <= 0.005) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 0.95 + this.heartbeatIntensity * 0.25;
    const gain = this.ctx.createGain();
    gain.gain.value = Math.min(1, this.heartbeatIntensity) * 0.9;
    src.connect(gain).connect(this.master);
    src.start();
  }

  setHeartbeatIntensity(t) {
    // t: 0 (silent) -> 1 (max panic)
    this.heartbeatIntensity = Math.max(0, Math.min(1, t));
  }

  startChaseMusic() {
    if (this.chaseSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.chase;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.master);
    src.start();
    this.chaseSource = src;
    this.chaseGain = gain;
    const rampUp = () => {
      if (!this.chaseGain) return;
      this.chaseGain.gain.linearRampToValueAtTime(0.85, this.ctx.currentTime + 0.6);
    };
    rampUp();
  }

  stopChaseMusic() {
    if (!this.chaseSource) return;
    this.chaseGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1.2);
    const src = this.chaseSource;
    setTimeout(() => {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }, 1300);
    this.chaseSource = null;
    this.chaseGain = null;
  }
}
