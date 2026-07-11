import * as THREE from "../vendor/three.module.js";
import { resolveCollision } from "./level.js";

const WALK_SPEED = 3.2;
const RUN_SPEED = 5.4;
const RADIUS = 0.32;
const EYE_HEIGHT = 1.65;

export class Player {
  constructor(camera, domElement, spawnWorld) {
    this.camera = camera;
    this.dom = domElement;
    this.pos = new THREE.Vector3(spawnWorld.x, EYE_HEIGHT, spawnWorld.z);
    this.yaw = 0;
    this.pitch = 0;

    this.stamina = 1; // 0..1
    this.flashlightBattery = 1; // 0..1
    this.flashlightOn = true;
    this.isRunning = false;
    this.isMoving = false;
    this.locked = false;
    this.isTouch = "ontouchstart" in window;
    this.touchRunHeld = false;

    this.keys = new Set();
    this._setupDesktopInput();
    if (this.isTouch) this._setupTouchInput();

    this._applyCamera();
  }

  _setupDesktopInput() {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "KeyF") this.toggleFlashlight();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    this.dom.addEventListener("click", () => {
      if (!this.isTouch) this.dom.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.dom;
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
    });
  }

  _setupTouchInput() {
    this.touchMove = { active: false, id: null, startX: 0, startY: 0, dx: 0, dy: 0 };
    this.touchLook = { active: false, id: null, lastX: 0, lastY: 0 };

    // passive: false + preventDefault() everywhere here is deliberate -
    // with passive listeners (the previous default), preventDefault() is
    // a silent no-op, so nothing ever actually told Safari these two
    // simultaneous touches (move + look) weren't a pinch-zoom gesture. It
    // would zoom the page and occasionally trigger a back/close gesture
    // from underneath the game entirely.
    window.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.clientX < window.innerWidth / 2 && !this.touchMove.active) {
            this.touchMove.active = true;
            this.touchMove.id = t.identifier;
            this.touchMove.startX = t.clientX;
            this.touchMove.startY = t.clientY;
          } else if (t.clientX >= window.innerWidth / 2 && !this.touchLook.active) {
            this.touchLook.active = true;
            this.touchLook.id = t.identifier;
            this.touchLook.lastX = t.clientX;
            this.touchLook.lastY = t.clientY;
          }
        }
      },
      { passive: false }
    );

    window.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (this.touchMove.active && t.identifier === this.touchMove.id) {
            this.touchMove.dx = t.clientX - this.touchMove.startX;
            this.touchMove.dy = t.clientY - this.touchMove.startY;
          } else if (this.touchLook.active && t.identifier === this.touchLook.id) {
            const dx = t.clientX - this.touchLook.lastX;
            const dy = t.clientY - this.touchLook.lastY;
            this.yaw -= dx * 0.0035;
            this.pitch -= dy * 0.0035;
            this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
            this.touchLook.lastX = t.clientX;
            this.touchLook.lastY = t.clientY;
          }
        }
      },
      { passive: false }
    );

    window.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier === this.touchMove.id) {
            this.touchMove.active = false;
            this.touchMove.dx = 0;
            this.touchMove.dy = 0;
          }
          if (t.identifier === this.touchLook.id) this.touchLook.active = false;
        }
      },
      { passive: false }
    );

    // Safari's proprietary pinch/rotate gesture events bypass normal
    // touch handling entirely - block them directly as a second layer,
    // since touch-action/preventDefault above doesn't reliably stop them
    // on every iOS version.
    document.addEventListener("gesturestart", (e) => e.preventDefault());
    document.addEventListener("gesturechange", (e) => e.preventDefault());
    document.addEventListener("gestureend", (e) => e.preventDefault());
  }

  toggleFlashlight() {
    if (this.flashlightBattery <= 0) {
      this.flashlightOn = false;
      return;
    }
    this.flashlightOn = !this.flashlightOn;
  }

  _applyCamera() {
    this.camera.position.copy(this.pos);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  update(dt) {
    let moveX = 0;
    let moveZ = 0; // forward/right in local space, -1..1

    if (this.isTouch) {
      const dead = 12;
      const dx = this.touchMove.dx;
      const dy = this.touchMove.dy;
      if (Math.abs(dx) > dead || Math.abs(dy) > dead) {
        moveX = Math.max(-1, Math.min(1, dx / 45));
        moveZ = Math.max(-1, Math.min(1, dy / 45));
      }
    } else {
      if (this.keys.has("KeyW")) moveZ -= 1;
      if (this.keys.has("KeyS")) moveZ += 1;
      if (this.keys.has("KeyA")) moveX -= 1;
      if (this.keys.has("KeyD")) moveX += 1;
    }

    const wantsRun = this.isTouch ? this.touchRunHeld : this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const moving = moveX !== 0 || moveZ !== 0;
    this.isMoving = moving;
    this.isRunning = moving && wantsRun && this.stamina > 0.05;

    const speed = this.isRunning ? RUN_SPEED : WALK_SPEED;

    if (moving) {
      const len = Math.hypot(moveX, moveZ) || 1;
      const nx = moveX / len;
      const nz = moveZ / len;

      // Camera looks down -Z at yaw=0 (Three.js convention).
      const forwardX = -Math.sin(this.yaw);
      const forwardZ = -Math.cos(this.yaw);
      const rightX = Math.cos(this.yaw);
      const rightZ = -Math.sin(this.yaw);

      const dirX = forwardX * -nz + rightX * nx;
      const dirZ = forwardZ * -nz + rightZ * nx;
      const dirLen = Math.hypot(dirX, dirZ) || 1;

      this.pos.x += (dirX / dirLen) * speed * dt;
      this.pos.z += (dirZ / dirLen) * speed * dt;
    }

    resolveCollision(this.pos, RADIUS);

    if (this.isRunning) this.stamina = Math.max(0, this.stamina - dt * 0.35);
    else this.stamina = Math.min(1, this.stamina + dt * 0.18);

    if (this.flashlightOn) {
      // ~6 minutes of continuous use on a full charge.
      this.flashlightBattery = Math.max(0, this.flashlightBattery - dt * 0.0028);
      if (this.flashlightBattery <= 0) this.flashlightOn = false;
    }

    this._applyCamera();
  }

  get noiseRadius() {
    // Walking radius needs to be large enough to actually carry through a
    // nearby wall sometimes - at the old 3.5 it never exceeded this
    // level's wall thickness, so "heard but not seen" could never happen.
    return this.isRunning ? 9 : 5;
  }
}
