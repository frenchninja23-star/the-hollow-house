import * as THREE from "../vendor/three.module.js";
import { buildLevelMeshes, cellToWorld, worldToCell, ITEM_CELLS, SPAWN_CELL, MONSTER_SPAWN_CELL, DOOR_CELL, openDoor } from "./level.js";
import { Player } from "./player.js";
import { Monster } from "./monster.js";
import { AudioManager } from "./audio.js";

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.026);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;
document.getElementById("app").appendChild(renderer.domElement);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

buildLevelMeshes(scene);

// Three.js r155+ uses physically-based (candela) light units, so these
// intensities are much larger than the old pre-physical scale would need.
const ambient = new THREE.AmbientLight(0x14141c, 2.0);
scene.add(ambient);

const spawnWorld = cellToWorld(SPAWN_CELL.x, SPAWN_CELL.z);
const player = new Player(camera, renderer.domElement, spawnWorld);

// Wide, far-reaching beam - this is the player's only real tool for seeing
// the house, so it needs to actually illuminate a usable area.
const flashlight = new THREE.SpotLight(0xfff2d8, 0, 26, Math.PI / 4.2, 0.5, 1.5);
flashlight.position.set(0, 0, 0);
camera.add(flashlight);
camera.add(flashlight.target);
flashlight.target.position.set(0, 0, -1);
scene.add(camera);

const itemMeshes = [];
const itemGeo = new THREE.OctahedronGeometry(0.22);
const itemMat = new THREE.MeshStandardMaterial({ color: 0xd9c27a, emissive: 0x554215, emissiveIntensity: 0.8 });
for (const cell of ITEM_CELLS) {
  const w = cellToWorld(cell.x, cell.z);
  const mesh = new THREE.Mesh(itemGeo, itemMat);
  mesh.position.set(w.x, 1.1, w.z);
  mesh.userData.collected = false;
  mesh.userData.roomName = cell.roomName;
  const light = new THREE.PointLight(0xd9c27a, 12, 4);
  mesh.add(light);
  scene.add(mesh);
  itemMeshes.push(mesh);
}

const monster = new Monster(scene, MONSTER_SPAWN_CELL);

const audio = new AudioManager();
let audioReady = false;

const state = {
  collected: 0,
  total: ITEM_CELLS.length,
  playing: false,
  chaseActive: false,
};

// ---- HUD ----
const staminaBar = document.getElementById("stamina-fill");
const batteryBar = document.getElementById("battery-fill");
const itemCounter = document.getElementById("item-counter");
const objectiveText = document.getElementById("objective-text");
const startScreen = document.getElementById("start-screen");
const gameOverScreen = document.getElementById("gameover-screen");
const winScreen = document.getElementById("win-screen");
const jumpscareFlash = document.getElementById("jumpscare-flash");
const pickupToast = document.getElementById("pickup-toast");

function updateObjectiveText() {
  if (state.collected < state.total) {
    objectiveText.textContent = `Find the ${state.total} photographs scattered through the house.`;
  } else {
    objectiveText.textContent = `All photographs found. Get to the front door and leave.`;
  }
}
updateObjectiveText();

async function beginGame() {
  startScreen.classList.add("hidden");
  audio.createContext();
  audio.unlock();
  if (!audioReady) {
    await audio.loadSounds();
    audioReady = true;
  }
  audio.startAmbience();
  audio.startHeartbeatLoop();
  state.playing = true;
  if (player.isTouch) document.getElementById("touch-controls").classList.remove("hidden");
}

document.getElementById("start-btn").addEventListener("click", beginGame);
document.getElementById("restart-btn-death").addEventListener("click", () => window.location.reload());
document.getElementById("restart-btn-win").addEventListener("click", () => window.location.reload());

const flashlightBtn = document.getElementById("flashlight-btn");
if (flashlightBtn) {
  flashlightBtn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    player.toggleFlashlight();
  });
}
const runBtn = document.getElementById("run-btn");
if (runBtn) {
  runBtn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    player.touchRunHeld = true;
  });
  runBtn.addEventListener("touchend", (e) => {
    e.preventDefault();
    player.touchRunHeld = false;
  });
}

function showPickupToast(text) {
  pickupToast.textContent = text;
  pickupToast.classList.add("show");
  clearTimeout(showPickupToast._t);
  showPickupToast._t = setTimeout(() => pickupToast.classList.remove("show"), 2200);
}

function jumpscare(onDone) {
  jumpscareFlash.classList.add("show");
  audio.playOneShot(Math.random() < 0.5 ? "roar1" : "roar2", { volume: 1 });
  setTimeout(() => {
    jumpscareFlash.classList.remove("show");
    if (onDone) onDone();
  }, 900);
}

function gameOver() {
  if (!state.playing) return;
  state.playing = false;
  jumpscare(() => gameOverScreen.classList.remove("hidden"));
}
monster.onCatch = gameOver;

monster.onStateChange = (next) => {
  if (next === "hunt" && !state.chaseActive) {
    state.chaseActive = true;
    audio.startChaseMusic();
  } else if (next !== "hunt" && state.chaseActive) {
    state.chaseActive = false;
    audio.stopChaseMusic();
  }
};

function win() {
  if (!state.playing) return;
  state.playing = false;
  winScreen.classList.remove("hidden");
}

const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, clock.getDelta());

  if (state.playing) {
    player.update(dt);

    for (const mesh of itemMeshes) {
      if (mesh.userData.collected) continue;
      mesh.rotation.y += dt * 1.4;
      mesh.position.y = 1.1 + Math.sin(performance.now() * 0.002 + mesh.id) * 0.08;
      const d = Math.hypot(mesh.position.x - player.pos.x, mesh.position.z - player.pos.z);
      if (d < 1.0) {
        mesh.userData.collected = true;
        scene.remove(mesh);
        state.collected++;
        itemCounter.textContent = `${state.collected} / ${state.total}`;
        showPickupToast(`Found a photograph - ${mesh.userData.roomName}`);
        updateObjectiveText();
        if (state.collected >= state.total) openDoor();
      }
    }

    const playerCell = worldToCell(player.pos.x, player.pos.z);
    if (state.collected >= state.total && playerCell.x === DOOR_CELL.x && playerCell.z === DOOR_CELL.z) {
      win();
    }

    const result = monster.update(dt, player);

    const proximity = 1 - Math.min(result.dist2D, 22) / 22;
    const panicBoost = result.state === "hunt" ? 0.35 : 0;
    audio.setHeartbeatIntensity(Math.min(1, proximity * 0.8 + panicBoost));

    flashlight.intensity = player.flashlightOn ? 100 : 0;
    staminaBar.style.width = `${player.stamina * 100}%`;
    batteryBar.style.width = `${player.flashlightBattery * 100}%`;
  }

  renderer.render(scene, camera);
}
tick();

if (window.__EXPOSE_TEST_HOOKS__) {
  window.__test = { state, win, gameOver, player, monster, itemMeshes };
}
