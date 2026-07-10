import * as THREE from "../vendor/three.module.js";
import { findPath } from "./pathfinding.js";
import { cellToWorld, worldToCell, hasLineOfSight, ROOMS } from "./level.js";

const PATROL_SPEED = 2.0;
const HUNT_SPEED = 4.3;
const SIGHT_RANGE = 11; // cells
const REPATH_INTERVAL = 0.5;
const SEARCH_TIMEOUT = 8; // seconds of searching before giving up
const CATCH_DISTANCE = 0.9;

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

  update(dt, player) {
    const myCell = worldToCell(this.pos.x, this.pos.z);
    const playerCell = worldToCell(player.pos.x, player.pos.z);

    const dist2D = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    const cellDist = Math.hypot(playerCell.x - myCell.x, playerCell.z - myCell.z);

    const seesPlayer =
      cellDist <= SIGHT_RANGE && hasLineOfSight(myCell.x, myCell.z, playerCell.x, playerCell.z);
    const hearsPlayer = dist2D <= player.noiseRadius && player.isRunning;

    if (seesPlayer || hearsPlayer) {
      this._setState("hunt");
      this.lastKnownCell = playerCell;
      this.searchTimer = 0;
    } else if (this.state === "hunt") {
      this._setState("search");
      this.searchTimer = SEARCH_TIMEOUT;
    }

    if (this.state === "search") {
      this.searchTimer -= dt;
      if (this.searchTimer <= 0) this._setState("patrol");
    }

    // Repath periodically rather than every frame.
    this.repathTimer -= dt;
    if (this.repathTimer <= 0 || this.path.length === 0) {
      this.repathTimer = REPATH_INTERVAL;
      let goal = null;
      if (this.state === "hunt" || this.state === "search") goal = this.lastKnownCell;
      else {
        if (!this._patrolTarget || Math.random() < 0.02) this._patrolTarget = this._pickPatrolTarget();
        goal = this._patrolTarget;
      }
      if (goal) {
        this.path = findPath(myCell.x, myCell.z, goal.x, goal.z);
        if (this.path.length === 0 && this.state === "patrol") this._patrolTarget = null;
      }
    }

    const speed = this.state === "hunt" ? HUNT_SPEED : PATROL_SPEED;
    if (this.path.length > 0) {
      const next = this.path[0];
      const target = cellToWorld(next.x, next.z);
      const dx = target.x - this.pos.x;
      const dz = target.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) {
        this.path.shift();
      } else {
        this.pos.x += (dx / d) * speed * dt;
        this.pos.z += (dz / d) * speed * dt;
        this.mesh.rotation.y = Math.atan2(dx, dz);
      }
    }

    this.mesh.position.set(this.pos.x, 0, this.pos.z);
    this._animate(dt);

    if (dist2D <= CATCH_DISTANCE && this.onCatch) {
      this.onCatch();
    }

    return { dist2D, state: this.state };
  }

  // Small continuous per-frame noise on top of the rig's rest pose - the
  // "wrongness" of a figure that never quite holds still is doing more
  // work here than the geometry itself.
  _animate(dt) {
    this.age += dt;
    const frantic = this.state === "hunt";
    const amp = frantic ? 0.09 : 0.035;
    const speed = frantic ? 9 : 2.4;
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

function makeSegment(length, thickness, mat) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, length, thickness), mat);
  mesh.position.y = -length / 2;
  group.add(mesh);
  return group;
}

function buildMonsterMesh(monster) {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x0a080b, roughness: 0.4, metalness: 0.15 });

  const hips = new THREE.Group();
  hips.position.y = 0.95;
  group.add(hips);

  // Spine leans forward into a hunch rather than standing upright - reads
  // as "wrong" without needing detailed geometry.
  const spine = new THREE.Group();
  spine.rotation.x = 0.4;
  hips.add(spine);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.85, 0.3), skin);
  torso.position.y = 0.42;
  spine.add(torso);

  const chest = new THREE.Group();
  chest.position.y = 0.85;
  chest.rotation.x = -0.25;
  spine.add(chest);

  const neck = new THREE.Group();
  neck.position.y = 0.15;
  neck.rotation.x = 0.55;
  chest.add(neck);

  const head = new THREE.Group();
  head.position.y = 0.22;
  head.rotation.z = 0.14; // cocked to one side - small but effective
  neck.add(head);
  const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.32, 0.24), skin);
  headMesh.position.y = 0.14;
  head.add(headMesh);

  // Asymmetric eyes - deliberately not a neat matched pair.
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x8a0000 });
  const leftEye = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.03, 0.02), eyeMat);
  leftEye.position.set(-0.075, 0.16, 0.13);
  head.add(leftEye);
  const rightEye = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.02), eyeMat);
  rightEye.position.set(0.08, 0.12, 0.13);
  head.add(rightEye);

  // Arms - grotesquely long, hanging well past where knees would be, bent
  // at unnatural, mismatched angles left vs right.
  const shoulderL = new THREE.Group();
  shoulderL.position.set(-0.24, 0.75, 0);
  spine.add(shoulderL);
  const upperArmL = makeSegment(0.62, 0.1, skin);
  upperArmL.rotation.x = 0.2;
  upperArmL.rotation.z = -0.1;
  shoulderL.add(upperArmL);
  const forearmL = makeSegment(0.68, 0.085, skin);
  forearmL.position.y = -0.62;
  forearmL.rotation.x = 0.15;
  upperArmL.add(forearmL);

  const shoulderR = new THREE.Group();
  shoulderR.position.set(0.24, 0.75, 0);
  spine.add(shoulderR);
  const upperArmR = makeSegment(0.6, 0.1, skin);
  upperArmR.rotation.x = 0.55;
  upperArmR.rotation.z = 0.15;
  shoulderR.add(upperArmR);
  const forearmR = makeSegment(0.66, 0.085, skin);
  forearmR.position.y = -0.6;
  forearmR.rotation.x = -1.1; // bends the "wrong" way - uncanny asymmetry
  upperArmR.add(forearmR);

  // Legs - slightly crouched, digitigrade-ish stance.
  const legGeo = () => {
    const g = new THREE.Group();
    const upper = makeSegment(0.5, 0.14, skin);
    upper.rotation.x = 0.3;
    g.add(upper);
    const lower = makeSegment(0.55, 0.11, skin);
    lower.position.y = -0.5;
    lower.rotation.x = -0.55;
    upper.add(lower);
    return g;
  };
  const legL = legGeo();
  legL.position.set(-0.14, 0.95, 0);
  group.add(legL);
  const legR = legGeo();
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
