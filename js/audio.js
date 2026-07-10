// Thin wrapper around the WebAudio-backed <audio> elements so the rest of
// the game can just call named sound events.
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.ambientSource = null;
    this.heartbeatGain = null;
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

  startHeartbeatLoop() {
    if (this.heartbeatSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.heartbeat;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.master);
    src.start();
    this.heartbeatSource = src;
    this.heartbeatGain = gain;
  }

  setHeartbeatIntensity(t) {
    // t: 0 (silent) -> 1 (max panic)
    if (!this.heartbeatGain) return;
    this.heartbeatGain.gain.value = Math.max(0, Math.min(1, t)) * 1.2;
    if (this.heartbeatSource) this.heartbeatSource.playbackRate.value = 0.85 + t * 0.7;
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
