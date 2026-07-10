import * as THREE from "../vendor/three.module.js";

// Grid-based house layout. Cell size in world units - kept small (human
// scale) so rooms read as tight and navigable rather than cavernous.
export const CELL = 3.2;
export const GRID_W = 20;
export const GRID_H = 13;
export const WALL_HEIGHT = 3;

// Rooms are placed so they touch the central single-file spine directly -
// no gap corridors needed, which keeps connectivity trivially guaranteed.
// A 1-wide hallway (rather than 2) keeps corridors tight and cornerable.
export const ROOMS = [
  { name: "Entrance Hall", x: 1, z: 2, w: 4, d: 5 },
  { name: "Living Room", x: 8, z: 3, w: 4, d: 4 },
  { name: "Kitchen", x: 15, z: 2, w: 4, d: 5 },
  { name: "Bathroom", x: 1, z: 8, w: 3, d: 4 },
  { name: "Bedroom", x: 7, z: 8, w: 5, d: 5 },
  { name: "Study", x: 15, z: 8, w: 4, d: 4 },
];
const SPINE = { x: 0, z: 7, w: 20, d: 1 };

// Clutter cells that break up sightlines and open floor space. Kept sparse
// and off the room's spine-facing edge so connectivity always holds.
const OBSTACLES = [
  { x: 9, z: 3 },
  { x: 16, z: 2 },
  { x: 17, z: 5 },
  { x: 8, z: 9 },
  { x: 10, z: 11 },
  { x: 16, z: 9 },
];

export const DOOR_CELL = { x: 2, z: 1 };
export const SPAWN_CELL = { x: 2, z: 4 };
export const MONSTER_SPAWN_CELL = { x: 16, z: 9 };

// One item per non-entrance room.
export const ITEM_ROOMS = [1, 2, 3, 4, 5];
export const ITEM_CELLS = ITEM_ROOMS.map((i) => {
  const r = ROOMS[i];
  return { x: Math.floor(r.x + r.w / 2), z: Math.floor(r.z + r.d / 2), roomName: r.name };
});

// grid values: 0 = solid wall, 1 = floor, 2 = locked door (solid until
// opened), 3 = obstacle clutter (solid, rendered distinctly from walls)
export const grid = [];
for (let z = 0; z < GRID_H; z++) {
  grid.push(new Array(GRID_W).fill(0));
}

function fillRect(rect) {
  for (let z = rect.z; z < rect.z + rect.d; z++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (x >= 0 && x < GRID_W && z >= 0 && z < GRID_H) grid[z][x] = 1;
    }
  }
}

for (const r of ROOMS) fillRect(r);
fillRect(SPINE);
grid[DOOR_CELL.z][DOOR_CELL.x] = 2;
for (const o of OBSTACLES) grid[o.z][o.x] = 3;

export function cellToWorld(cx, cz) {
  return { x: cx * CELL + CELL / 2, z: cz * CELL + CELL / 2 };
}
export function worldToCell(x, z) {
  return { x: Math.floor(x / CELL), z: Math.floor(z / CELL) };
}
export function isWalkable(cx, cz) {
  if (cx < 0 || cx >= GRID_W || cz < 0 || cz >= GRID_H) return false;
  return grid[cz][cx] === 1;
}
export function isOpenOrFloor(cx, cz) {
  if (cx < 0 || cx >= GRID_W || cz < 0 || cz >= GRID_H) return false;
  return grid[cz][cx] === 1 || grid[cz][cx] === 2;
}

export function openDoor() {
  grid[DOOR_CELL.z][DOOR_CELL.x] = 1;
}

// Circle-vs-solid-cell collision resolution for the player capsule.
export function resolveCollision(pos, radius) {
  const cell = worldToCell(pos.x, pos.z);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = cell.x + dx;
      const cz = cell.z + dz;
      if (isOpenOrFloor(cx, cz)) continue;
      const minX = cx * CELL;
      const maxX = minX + CELL;
      const minZ = cz * CELL;
      const maxZ = minZ + CELL;
      const closestX = Math.max(minX, Math.min(pos.x, maxX));
      const closestZ = Math.max(minZ, Math.min(pos.z, maxZ));
      const dxp = pos.x - closestX;
      const dzp = pos.z - closestZ;
      const distSq = dxp * dxp + dzp * dzp;
      if (distSq < radius * radius && distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        const push = radius - dist;
        pos.x += (dxp / dist) * push;
        pos.z += (dzp / dist) * push;
      } else if (distSq <= 1e-8) {
        // Center is inside the wall cell (shouldn't normally happen) - shove
        // out along the shallowest axis.
        const overlapX = Math.min(pos.x - minX, maxX - pos.x);
        const overlapZ = Math.min(pos.z - minZ, maxZ - pos.z);
        if (overlapX < overlapZ) pos.x += pos.x - (minX + maxX) / 2 > 0 ? overlapX : -overlapX;
        else pos.z += pos.z - (minZ + maxZ) / 2 > 0 ? overlapZ : -overlapZ;
      }
    }
  }
}

// Line-of-sight between two grid cells using a simple DDA line walk.
export function hasLineOfSight(x0, z0, x1, z1) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const steps = Math.max(Math.abs(dx), Math.abs(dz)) * 2;
  if (steps === 0) return true;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.round(x0 + dx * t);
    const cz = Math.round(z0 + dz * t);
    if (!isOpenOrFloor(cx, cz)) return false;
  }
  return true;
}

export function buildLevelMeshes(scene) {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.95 });
  const doorWallMat = new THREE.MeshStandardMaterial({ color: 0x4a2020, roughness: 0.9 });
  const obstacleMat = new THREE.MeshStandardMaterial({ color: 0x1c1712, roughness: 1 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x14110d, roughness: 1 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x0a0908, roughness: 1 });

  const wallGeo = new THREE.BoxGeometry(CELL, WALL_HEIGHT, CELL);
  const obstacleHeight = WALL_HEIGHT * 0.5;
  const obstacleGeo = new THREE.BoxGeometry(CELL * 0.85, obstacleHeight, CELL * 0.85);
  let doorMesh = null;

  for (let z = 0; z < GRID_H; z++) {
    for (let x = 0; x < GRID_W; x++) {
      const v = grid[z][x];
      if (v === 0) {
        const mesh = new THREE.Mesh(wallGeo, wallMat);
        mesh.position.set(x * CELL + CELL / 2, WALL_HEIGHT / 2, z * CELL + CELL / 2);
        scene.add(mesh);
      } else if (v === 2) {
        doorMesh = new THREE.Mesh(wallGeo, doorWallMat);
        doorMesh.position.set(x * CELL + CELL / 2, WALL_HEIGHT / 2, z * CELL + CELL / 2);
        scene.add(doorMesh);
      } else if (v === 3) {
        const mesh = new THREE.Mesh(obstacleGeo, obstacleMat);
        mesh.position.set(x * CELL + CELL / 2, obstacleHeight / 2, z * CELL + CELL / 2);
        scene.add(mesh);
      }
    }
  }

  const floorW = GRID_W * CELL;
  const floorD = GRID_H * CELL;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorD), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(floorW / 2, 0, floorD / 2);
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorD), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(floorW / 2, WALL_HEIGHT, floorD / 2);
  scene.add(ceiling);

  return { doorMesh };
}
