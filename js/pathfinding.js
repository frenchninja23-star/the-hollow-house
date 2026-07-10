import { GRID_W, GRID_H, isOpenOrFloor } from "./level.js";

const NEIGHBORS = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
];

// Breadth-first search over the walkable grid. Returns an array of
// {x, z} cells from just after the start to the goal, or [] if unreachable.
export function findPath(startX, startZ, goalX, goalZ) {
  if (!isOpenOrFloor(startX, startZ) || !isOpenOrFloor(goalX, goalZ)) return [];
  if (startX === goalX && startZ === goalZ) return [];

  const visited = new Set([`${startX},${startZ}`]);
  const cameFrom = new Map();
  const queue = [{ x: startX, z: startZ }];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.x === goalX && cur.z === goalZ) break;

    for (const n of NEIGHBORS) {
      const nx = cur.x + n.dx;
      const nz = cur.z + n.dz;
      const key = `${nx},${nz}`;
      if (visited.has(key) || !isOpenOrFloor(nx, nz)) continue;
      visited.add(key);
      cameFrom.set(key, cur);
      queue.push({ x: nx, z: nz });
    }
    if (queue.length > GRID_W * GRID_H) break; // safety bound
  }

  const goalKey = `${goalX},${goalZ}`;
  if (!cameFrom.has(goalKey) && !(startX === goalX && startZ === goalZ)) {
    if (!visited.has(goalKey)) return [];
  }

  const path = [];
  let curKey = goalKey;
  let cur = { x: goalX, z: goalZ };
  while (curKey !== `${startX},${startZ}`) {
    path.push(cur);
    const prev = cameFrom.get(curKey);
    if (!prev) break;
    cur = prev;
    curKey = `${cur.x},${cur.z}`;
  }
  path.reverse();
  return path;
}
