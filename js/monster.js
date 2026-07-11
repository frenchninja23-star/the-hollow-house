import * as THREE from "../vendor/three.module.js";
import { findPath } from "./pathfinding.js";
import { cellToWorld, worldToCell, hasLineOfSight, ROOMS } from "./level.js";

const PATROL_SPEED = 2.0;
const ALERT_SPEED = 2.8; // investigating a noise/sighting - cautious, not yet all-out
const HUNT_SPEED = 4.3;
// The house's rooms are only connected by one long, fully unobstructed
// corridor - at longer sight ranges that corridor turns into a near
// guaranteed instant-detection trap the moment both happen to be in it.
const SIGHT_RANGE = 6; // cells
const REPATH_INTERVAL = 0.5;
const CATCH_DISTANCE = 0.9;
const NOTICE_DURATION = 0.5; // freeze-and-react beat before it commits to the chase
const GRACE_PERIOD = 25; // seconds of safety after game start to get oriented

// A continuous 0-100 aggro meter instead of a hard on/off switch - this is
// what actually lets a player de-escalate an encounter (go quiet, kill the
// flashlight, break line of sight) instead of being stuck in a fixed-length
// hunt/search timer once spotted once.
const AGGRO_MAX = 100;
const AGGRO_DECAY_PER_SEC = 6;
const AGGRO_HEARING_WALK_PER_SEC = 6;
const AGGRO_HEARING_RUN_PER_SEC = 16;
const AGGRO_SIGHT_LIT_PER_SEC = 24; // visible AND flashlight on - lit up and obvious
const AGGRO_TOUCH_SPIKE = 80;
const AGGRO_SUSPICIOUS_ENTER = 25;
const AGGRO_SUSPICIOUS_EXIT = 12; // hysteresis so it doesn't flicker at the boundary
const AGGRO_HUNT_ENTER = 70;
const AGGRO_HUNT_EXIT = 45;

export class Monster {
  constructor(scene, spawnCell) {
    const w = cellToWorld(spawnCell.x, spawnCell.z);
    this.mesh = buildMonsterMesh(this);
    this.mesh.position.set(w.x, 0, w.z);
    scene.add(this.mesh);

    this.pos = new THREE.Vector3(w.x, 0, w.z);
    this.state = "patrol";
    this.path = [];
    this.repathTimer = 0;
    this.searchTimer = 0;
    this.lastKnownCell = null;
    this.onCatch = null;
    this.onStateChange = null;
    this.jitterSeed = Math.random() * 1000;
    this.age = 0;
    this.graceTimer = GRACE_PERIOD;
    this.aggro = 0;
  }

  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    if (this.onStateChange) this.onStateChange(next);
  }

  _pickPatrolTarget() {
    const room = ROOMS[Math.floor(Math.random() * ROOMS.length)];
    return {
      x: Math.floor(room.x + Math.random() * room.w),
      z: Math.floor(room.z + Math.random() * room.d),
    };
  }

  // players: array of one or two {pos, isMoving, isRunning, flashlightOn,
  // noiseRadius} - in co-op it tracks whichever player is currently most
  // exposed (loudest or most visible) rather than summing every player's
  // contribution, so being in a party doesn't make detection unfairly
  // faster just from both of you existing near it at once.
  update(dt, players) {
    if (this.graceTimer > 0) this.graceTimer -= dt;
    const graceActive = this.graceTimer > 0;

    const myCell = worldToCell(this.pos.x, this.pos.z);
    const evals = players.map((player) => this._evaluateDetection(player, myCell, graceActive));

    const anyTouching = evals.some((e) => e.touching);
    const maxRate = Math.max(0, ...evals.map((e) => e.rate));

    // --- Aggro: accumulates from hearing/sight/touch, decays otherwise.
    if (!graceActive) {
      if (anyTouching) this.aggro = Math.min(AGGRO_MAX, this.aggro + AGGRO_TOUCH_SPIKE);
      if (maxRate > 0) {
        this.aggro = Math.min(AGGRO_MAX, this.aggro + maxRate * dt);
      } else if (!anyTouching) {
        this.aggro = Math.max(0, this.aggro - AGGRO_DECAY_PER_SEC * dt);
      }
    }

    // Whoever is currently most exposed becomes the pursuit target -
    // touching beats any passive detection, then higher rate, then closer.
    let target = null;
    for (const e of evals) {
      if (!e.touching && !e.seesPlayer && !e.hearsPlayer) continue;
      if (
        !target ||
        (e.touching && !target.touching) ||
        (e.touching === target.touching && e.rate > target.rate) ||
        (e.touching === target.touching && e.rate === target.rate && e.dist2D < target.dist2D)
      ) {
        target = e;
      }
    }
    if (target) this.lastKnownCell = target.playerCell;

    // dist2D of the closest currently-relevant player, mostly useful for
    // solo mode and debugging - each client computes its own local
    // distance to the monster for its own heartbeat feedback rather than
    // relying on this in multiplayer.
    const dist2D = Math.min(...evals.map((e) => e.dist2D));

    // --- State follows the aggro meter, with hysteresis at each boundary
    // so it doesn't flicker back and forth right at a threshold.
    if (this.state === "hunt") {
      if (this.aggro < AGGRO_HUNT_EXIT) this._setState("suspicious");
    } else if (this.state === "suspicious") {
      if (this.aggro >= AGGRO_HUNT_ENTER) {
        this._setState("noticing");
        this.noticeTimer = NOTICE_DURATION;
      } else if (this.aggro < AGGRO_SUSPICIOUS_EXIT) {
        this._setState("patrol");
      }
    } else if (this.state === "patrol") {
      if (this.aggro >= AGGRO_HUNT_ENTER) {
        this._setState("noticing");
        this.noticeTimer = NOTICE_DURATION;
      } else if (this.aggro >= AGGRO_SUSPICIOUS_ENTER) {
        this._setState("suspicious");
      }
    }

    if (this.state === "noticing") {
      this.noticeTimer -= dt;
      if (this.noticeTimer <= 0) this._setState("hunt");
    }

    if (this.state === "noticing") {
      // Frozen reaction beat - no movement, just the (more frantic, via
      // _animate) idle jitter, so the player gets a moment to notice it's
      // noticed them before it commits to the chase.
    } else {
      // Repath periodically rather than every frame. This is the only
      // source of movement - it always stays on the walkable grid, so it
      // can never clip through a wall the way free-form steering toward a
      // live target could.
      this.repathTimer -= dt;
      if (this.repathTimer <= 0 || this.path.length === 0) {
        this.repathTimer = REPATH_INTERVAL;
        let goal = null;
        if (this.state === "hunt") {
          goal = this.lastKnownCell;
        } else if (this.state === "suspicious") {
          // Once it's arrived at the last place it heard/saw something
          // and isn't actively tracking anymore, keep searching nearby
          // instead of freezing in place at that one cell forever - which
          // otherwise reads as it just camping right next to a hiding
          // player rather than actually looking for them.
          const arrived =
            this.lastKnownCell && myCell.x === this.lastKnownCell.x && myCell.z === this.lastKnownCell.z;
          const activelyTracking = target !== null;
          if (this.lastKnownCell && !(arrived && !activelyTracking)) {
            goal = this.lastKnownCell;
          } else {
            if (!this._patrolTarget || Math.random() < 0.05) this._patrolTarget = this._pickPatrolTarget();
            goal = this._patrolTarget;
          }
        } else {
          if (!this._patrolTarget || Math.random() < 0.02) this._patrolTarget = this._pickPatrolTarget();
          goal = this._patrolTarget;
        }
        if (goal) {
          this.path = findPath(myCell.x, myCell.z, goal.x, goal.z);
          if (this.path.length === 0 && this.state !== "hunt") this._patrolTarget = null;
        }
      }

      const speed = this.state === "hunt" ? HUNT_SPEED : this.state === "suspicious" ? ALERT_SPEED : PATROL_SPEED;
      if (this.path.length > 0) {
        const next = this.path[0];
        const waypoint = cellToWorld(next.x, next.z);
        const dx = waypoint.x - this.pos.x;
        const dz = waypoint.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.15) {
          this.path.shift();
        } else {
          this.pos.x += (dx / d) * speed * dt;
          this.pos.z += (dz / d) * speed * dt;
          this.mesh.rotation.y = Math.atan2(dx, dz);
        }
      } else if (
        this.state === "hunt" &&
        target &&
        target.seesPlayer &&
        myCell.x === target.playerCell.x &&
        myCell.z === target.playerCell.z
      ) {
        // Path is exhausted and it's arrived at the target's cell, but
        // findPath resolves to cell centers, which can leave it up to
        // half a cell short of their actual position. Closing that last
        // bit directly is safe here specifically because both occupy the
        // same open cell - there is by definition no wall between them.
        const dx = target.player.pos.x - this.pos.x;
        const dz = target.player.pos.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.02) {
          this.pos.x += (dx / d) * HUNT_SPEED * dt;
          this.pos.z += (dz / d) * HUNT_SPEED * dt;
          this.mesh.rotation.y = Math.atan2(dx, dz);
        }
      }
    }

    this.mesh.position.set(this.pos.x, 0, this.pos.z);
    this._animate(dt);

    // Only an active, deliberate pursuit (or a touch spike that just
    // pushed it straight into that pursuit this same frame) can catch a
    // player - incidental proximity while it's just patrolling should not
    // be a death sentence. Report *which* player(s) by id rather than
    // array position, since the caller may have already excluded an
    // already-caught player from this array - a positional index would
    // silently point at the wrong person once the array is no longer
    // "everyone".
    const canCatch = this.state === "hunt" || this.state === "noticing";
    if (canCatch && anyTouching && this.onCatch) {
      const caughtIds = evals.filter((e) => e.touching).map((e) => e.player.id);
      this.onCatch(caughtIds);
    }

    return { dist2D, state: this.state, aggro: this.aggro };
  }

  _evaluateDetection(player, myCell, graceActive) {
    const playerCell = worldToCell(player.pos.x, player.pos.z);
    const dist2D = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    const cellDist = Math.hypot(playerCell.x - myCell.x, playerCell.z - myCell.z);

    const seesPlayer =
      !graceActive && cellDist <= SIGHT_RANGE && hasLineOfSight(myCell.x, myCell.z, playerCell.x, playerCell.z);
    const hearsPlayer = !graceActive && player.isMoving && dist2D <= player.noiseRadius;
    const touching = dist2D <= CATCH_DISTANCE;
    const visuallyDetected = seesPlayer && player.flashlightOn;

    let rate = 0;
    if (visuallyDetected) rate = AGGRO_SIGHT_LIT_PER_SEC;
    if (hearsPlayer) {
      rate = Math.max(rate, player.isRunning ? AGGRO_HEARING_RUN_PER_SEC : AGGRO_HEARING_WALK_PER_SEC);
    }

    return { player, playerCell, dist2D, cellDist, seesPlayer, hearsPlayer, touching, visuallyDetected, rate };
  }

  // Guest-side puppeting: rather than running the simulation locally
  // (which would require the guest to independently reconstruct aggro
  // from network-relayed player states and could drift from the host's
  // authoritative result), just drive the mesh directly from the host's
  // broadcast transform and state. Reuses the same mesh/animation code so
  // it looks identical to the locally-simulated version.
  applyNetworkState(x, z, rotationY, state, aggro, dt) {
    this.pos.x = x;
    this.pos.z = z;
    this.mesh.position.set(x, 0, z);
    this.mesh.rotation.y = rotationY;
    this.state = state;
    this.aggro = aggro;
    this._animate(dt);
  }

  // Small continuous per-frame noise on top of the rig's rest pose - the
  // "wrongness" of a figure that never quite holds still is doing more
  // work here than the geometry itself.
  _animate(dt) {
    this.age += dt;
    let amp, speed;
    if (this.state === "noticing") {
      amp = 0.16;
      speed = 14;
    } else if (this.state === "hunt") {
      amp = 0.09;
      speed = 9;
    } else if (this.state === "suspicious") {
      amp = 0.06;
      speed = 5;
    } else {
      amp = 0.035;
      speed = 2.4;
    }
    const t = this.age * speed + this.jitterSeed;

    const rig = this.rig;
    if (!rig) return;

    rig.head.rotation.x = rig.rest.head.x + Math.sin(t * 1.3) * amp * 1.4;
    rig.head.rotation.y = rig.rest.head.y + Math.sin(t * 0.7 + 1.1) * amp * 1.8;
    rig.head.rotation.z = rig.rest.head.z + Math.sin(t * 1.7 + 2.3) * amp;

    rig.armL.rotation.x = rig.rest.armL.x + Math.sin(t * 1.1 + 0.5) * amp;
    rig.armR.rotation.x = rig.rest.armR.x + Math.sin(t * 0.9 + 2.8) * amp;

    rig.spine.rotation.z = rig.rest.spine.z + Math.sin(t * 0.5) * amp * 0.6;
    rig.hips.position.y = rig.rest.hipsY + Math.sin(t * 2.1) * 0.015;
  }
}

// Tapered, faceted cylinder rather than a box - reads as an emaciated limb
// or bone instead of a stacked block. Low radial segment count (6) keeps
// it faceted/angular rather than a smooth, friendly-looking tube.
function makeSegment(length, radiusTop, radiusBottom, mat) {
  const group = new THREE.Group();
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 6);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -length / 2;
  group.add(mesh);
  return group;
}

function makeJoint(radius, mat) {
  return new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 0), mat);
}

function makeClawHand(mat) {
  const wrist = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), mat);
  wrist.add(palm);
  const clawGeo = new THREE.ConeGeometry(0.018, 0.16, 5);
  const spread = [
    { rx: 0.3, ry: -0.3, rz: 0 },
    { rx: 0.45, ry: 0, rz: 0 },
    { rx: 0.3, ry: 0.35, rz: 0 },
  ];
  for (const s of spread) {
    const claw = new THREE.Mesh(clawGeo, mat);
    claw.position.y = -0.08;
    const pivot = new THREE.Group();
    pivot.rotation.set(s.rx, s.ry, s.rz);
    pivot.add(claw);
    wrist.add(pivot);
  }
  return wrist;
}

// Procedural mottled skin - generated once and shared by every instance,
// so an actual creature material exists instead of a flat solid color.
let sharedSkinTexture = null;
function getSkinTexture() {
  if (sharedSkinTexture) return sharedSkinTexture;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#332c26";
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 3 + Math.random() * 16;
    const dark = Math.random() < 0.6;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, dark ? "#1c1712" : "#4a4038");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(100,15,15,0.4)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 50; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let j = 0; j < 4; j++) {
      x += (Math.random() - 0.5) * 22;
      y += (Math.random() - 0.5) * 22;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  sharedSkinTexture = new THREE.CanvasTexture(canvas);
  sharedSkinTexture.wrapS = THREE.RepeatWrapping;
  sharedSkinTexture.wrapT = THREE.RepeatWrapping;
  return sharedSkinTexture;
}

function buildMonsterMesh(monster) {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    map: getSkinTexture(),
    color: 0x8a8a8a,
    roughness: 0.62,
    metalness: 0.04,
  });
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x241f1a, roughness: 0.5 });

  const hips = new THREE.Group();
  hips.position.y = 0.95;
  group.add(hips);

  // Spine leans forward into a hunch rather than standing upright - reads
  // as "wrong" without needing detailed geometry. Gaunt ribcage tapers
  // narrower toward the shoulders instead of a uniform block.
  const spine = new THREE.Group();
  spine.rotation.x = 0.4;
  hips.add(spine);
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.19, 0.85, 7), skin);
  torso.position.y = 0.42;
  spine.add(torso);

  const chest = new THREE.Group();
  chest.position.y = 0.85;
  chest.rotation.x = -0.25;
  spine.add(chest);

  const neck = makeSegment(0.22, 0.05, 0.08, skin);
  neck.position.y = 0.02;
  neck.rotation.x = 0.55;
  chest.add(neck);

  const head = new THREE.Group();
  head.position.y = 0.28;
  head.rotation.z = 0.14; // cocked to one side - small but effective
  neck.add(head);
  // Faceted, elongated skull rather than a smooth sphere or a box - the
  // low-poly icosahedron catches light in irregular, unsettling planes.
  const headMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), skin);
  headMesh.scale.set(0.8, 1.35, 0.78);
  headMesh.position.y = 0.16;
  head.add(headMesh);

  // Asymmetric eyes - deliberately not a neat matched pair, no other
  // facial detail so the eyes read as the only thing looking back at you.
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x8a0000 });
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 6), eyeMat);
  leftEye.position.set(-0.075, 0.18, 0.15);
  head.add(leftEye);
  const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 6), eyeMat);
  rightEye.position.set(0.085, 0.13, 0.15);
  head.add(rightEye);

  // Arms - grotesquely long, hanging well past where knees would be, bent
  // at unnatural, mismatched angles left vs right, ending in clawed hands.
  const shoulderL = new THREE.Group();
  shoulderL.position.set(-0.24, 0.75, 0);
  spine.add(shoulderL);
  shoulderL.add(makeJoint(0.07, jointMat));
  const upperArmL = makeSegment(0.62, 0.06, 0.085, skin);
  upperArmL.rotation.x = 0.2;
  upperArmL.rotation.z = -0.1;
  shoulderL.add(upperArmL);
  const elbowL = makeJoint(0.05, jointMat);
  elbowL.position.y = -0.62;
  upperArmL.add(elbowL);
  const forearmL = makeSegment(0.68, 0.035, 0.06, skin);
  forearmL.position.y = -0.62;
  forearmL.rotation.x = 0.15;
  upperArmL.add(forearmL);
  const handL = makeClawHand(jointMat);
  handL.position.y = -0.68;
  forearmL.add(handL);

  const shoulderR = new THREE.Group();
  shoulderR.position.set(0.24, 0.75, 0);
  spine.add(shoulderR);
  shoulderR.add(makeJoint(0.07, jointMat));
  const upperArmR = makeSegment(0.6, 0.06, 0.085, skin);
  upperArmR.rotation.x = 0.55;
  upperArmR.rotation.z = 0.15;
  shoulderR.add(upperArmR);
  const elbowR = makeJoint(0.05, jointMat);
  elbowR.position.y = -0.6;
  upperArmR.add(elbowR);
  const forearmR = makeSegment(0.66, 0.035, 0.06, skin);
  forearmR.position.y = -0.6;
  forearmR.rotation.x = -1.1; // bends the "wrong" way - uncanny asymmetry
  upperArmR.add(forearmR);
  const handR = makeClawHand(jointMat);
  handR.position.y = -0.66;
  forearmR.add(handR);

  // Legs - slightly crouched, digitigrade-ish stance, tapering to thin
  // ankles rather than blocky shins.
  const buildLeg = () => {
    const g = new THREE.Group();
    const upper = makeSegment(0.5, 0.08, 0.13, skin);
    upper.rotation.x = 0.3;
    g.add(upper);
    const knee = makeJoint(0.055, jointMat);
    knee.position.y = -0.5;
    upper.add(knee);
    const lower = makeSegment(0.55, 0.045, 0.09, skin);
    lower.position.y = -0.5;
    lower.rotation.x = -0.55;
    upper.add(lower);
    return g;
  };
  const legL = buildLeg();
  legL.position.set(-0.14, 0.95, 0);
  group.add(legL);
  const legR = buildLeg();
  legR.position.set(0.14, 0.95, 0);
  group.add(legR);

  const rig = {
    hips,
    spine,
    head,
    armL: upperArmL,
    armR: upperArmR,
    rest: {
      head: { x: head.rotation.x, y: head.rotation.y, z: head.rotation.z },
      armL: { x: upperArmL.rotation.x },
      armR: { x: upperArmR.rotation.x },
      spine: { z: spine.rotation.z },
      hipsY: hips.position.y,
    },
  };
  if (monster) monster.rig = rig;

  return group;
}
