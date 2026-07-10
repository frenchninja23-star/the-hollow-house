import * as THREE from "../vendor/three.module.js";
import { buildLevelMeshes, cellToWorld, worldToCell, ITEM_CELLS, SPAWN_CELL, MONSTER_SPAWN_CELL, DOOR_CELL, openDoor } from "./level.js";
import { Player } from "./player.js";
import { Monster } from "./monster.js";
import { AudioManager } from "./audio.js";
import { Network } from "./network.js";
import { RemotePlayer } from "./remoteplayer.js";

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
const remotePlayer = new RemotePlayer(scene);

const audio = new AudioManager();
let audioReady = false;

// mode: "solo" | "host" | "guest". Host runs the authoritative simulation
// (monster AI, item pickups, door/win) and broadcasts it; guest runs its
// own local player fully client-side for responsiveness and renders
// everything else from the host's snapshots.
let mode = "solo";
const network = new Network();
let remoteConnected = false;
let remoteState = null; // guest's live state, as known by the host
let latestSnapshot = null; // host's authoritative world state, as known by the guest

const state = {
  collected: 0,
  total: ITEM_CELLS.length,
  playing: false,
  chaseActive: false,
  gameOverFired: false,
  winFired: false,
};

// ---- HUD ----
const staminaBar = document.getElementById("stamina-fill");
const batteryBar = document.getElementById("battery-fill");
const itemCounter = document.getElementById("item-counter");
const objectiveText = document.getElementById("objective-text");
const partyScreen = document.getElementById("party-screen");
const startScreen = document.getElementById("start-screen");
const waitingScreen = document.getElementById("waiting-screen");
const gameOverScreen = document.getElementById("gameover-screen");
const gameOverHeading = document.getElementById("gameover-heading");
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

// ---- Party lobby ----
const partyChoice = document.getElementById("party-choice");
const hostPanel = document.getElementById("host-panel");
const joinPanel = document.getElementById("join-panel");
const codeDisplay = document.getElementById("party-code-display");
const hostStatus = document.getElementById("host-status");
const hostStartBtn = document.getElementById("host-start-btn");
const joinCodeInput = document.getElementById("join-code-input");
const joinSubmitBtn = document.getElementById("join-submit-btn");
const joinStatus = document.getElementById("join-status");
const waitingText = document.getElementById("waiting-text");

document.getElementById("solo-btn").addEventListener("click", () => {
  mode = "solo";
  partyScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
});

document.getElementById("host-btn").addEventListener("click", async () => {
  mode = "host";
  partyChoice.classList.add("hidden");
  hostPanel.classList.remove("hidden");
  hostStatus.textContent = "Setting up...";
  try {
    const code = await network.hostParty();
    codeDisplay.textContent = code;
    hostStatus.textContent = "Waiting for a friend to join...";
  } catch {
    hostStatus.textContent = "Couldn't create a party - check your connection and try again.";
  }
});

document.getElementById("join-btn").addEventListener("click", () => {
  mode = "guest";
  partyChoice.classList.add("hidden");
  joinPanel.classList.remove("hidden");
  joinCodeInput.focus();
});

async function submitJoin() {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    joinStatus.textContent = "Enter the 4-character code.";
    return;
  }
  joinSubmitBtn.disabled = true;
  joinStatus.textContent = "Connecting...";
  try {
    await network.joinParty(code);
    joinStatus.textContent = "";
    partyScreen.classList.add("hidden");
    waitingText.textContent = "Connected! Waiting for the host to start...";
    waitingScreen.classList.remove("hidden");
  } catch {
    joinStatus.textContent = "Couldn't find that party - check the code and try again.";
  } finally {
    joinSubmitBtn.disabled = false;
  }
}
joinSubmitBtn.addEventListener("click", submitJoin);
joinCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitJoin();
});
joinCodeInput.addEventListener("input", () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

for (const id of ["party-back-btn-1", "party-back-btn-2"]) {
  document.getElementById(id).addEventListener("click", () => {
    network.destroy();
    mode = "solo";
    hostPanel.classList.add("hidden");
    joinPanel.classList.add("hidden");
    partyChoice.classList.remove("hidden");
  });
}

hostStartBtn.addEventListener("click", () => {
  network.send({ t: "start" });
  partyScreen.classList.add("hidden");
  beginGame();
});

network.onPeerConnected = () => {
  if (mode === "host") {
    hostStatus.textContent = "Friend connected!";
    hostStartBtn.classList.remove("hidden");
  }
};

network.onPeerDisconnected = () => {
  remoteConnected = false;
  if (mode === "guest" && state.playing && !state.gameOverFired && !state.winFired) {
    state.gameOverFired = true;
    state.playing = false;
    gameOverHeading.textContent = "Connection Lost";
    gameOverScreen.classList.remove("hidden");
  } else if (mode === "host" && state.playing) {
    showPickupToast("Your friend disconnected.");
  }
};

network.onMessage = (data) => {
  if (mode === "host" && data.t === "input") {
    remoteState = data;
    remoteConnected = true;
  } else if (mode === "guest") {
    if (data.t === "start") {
      waitingScreen.classList.add("hidden");
      gameOverHeading.textContent = "You Were Caught";
      beginGame();
    } else if (data.t === "snapshot") {
      latestSnapshot = data;
    }
  }
};

document.getElementById("restart-btn-death").addEventListener("click", () => window.location.reload());
document.getElementById("restart-btn-win").addEventListener("click", () => window.location.reload());
document.getElementById("start-btn").addEventListener("click", beginGame);

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
  state.gameOverFired = true;
  jumpscare(() => gameOverScreen.classList.remove("hidden"));
  if (mode === "host") sendSnapshot();
}
monster.onCatch = gameOver;

monster.onStateChange = (next) => {
  if (next === "noticing") {
    audio.playOneShot("static", { volume: 0.9, pitch: 1.4 });
  }
  if (next === "hunt" && !state.chaseActive) {
    state.chaseActive = true;
    audio.playOneShot(Math.random() < 0.5 ? "roar1" : "roar2", { volume: 1 });
    audio.startChaseMusic();
  } else if (next !== "hunt" && state.chaseActive) {
    state.chaseActive = false;
    audio.stopChaseMusic();
  }
};

function win() {
  if (!state.playing) return;
  state.playing = false;
  state.winFired = true;
  winScreen.classList.remove("hidden");
  if (mode === "host") sendSnapshot();
}

function sendSnapshot() {
  network.send({
    t: "snapshot",
    hostPos: { x: player.pos.x, y: player.pos.y, z: player.pos.z },
    hostYaw: player.yaw,
    monster: { x: monster.pos.x, z: monster.pos.z, rotY: monster.mesh.rotation.y, state: monster.state, aggro: monster.aggro },
    collected: itemMeshes.map((m) => m.userData.collected),
    doorOpen: state.collected >= state.total,
    gameOver: state.gameOverFired,
    win: state.winFired,
  });
}

function animateItem(mesh, dt) {
  mesh.rotation.y += dt * 1.4;
  mesh.position.y = 1.1 + Math.sin(performance.now() * 0.002 + mesh.id) * 0.08;
}

const clock = new THREE.Clock();
const NET_INTERVAL = 0.05; // 20Hz - frequent enough to feel responsive, cheap enough not to matter
let netTimer = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, clock.getDelta());

  if (state.playing) {
    player.update(dt);
    remotePlayer.checkStale();
    netTimer += dt;
    const sendNow = netTimer >= NET_INTERVAL;
    if (sendNow) netTimer = 0;

    if (mode === "guest") {
      for (const mesh of itemMeshes) {
        if (!mesh.userData.collected) animateItem(mesh, dt);
      }

      if (sendNow) {
        network.send({
          t: "input",
          pos: { x: player.pos.x, y: player.pos.y, z: player.pos.z },
          yaw: player.yaw,
          isMoving: player.isMoving,
          isRunning: player.isRunning,
          flashlightOn: player.flashlightOn,
          noiseRadius: player.noiseRadius,
        });
      }

      if (latestSnapshot) {
        const m = latestSnapshot.monster;
        monster.applyNetworkState(m.x, m.z, m.rotY, m.state, m.aggro, dt);
        remotePlayer.updateFromState(latestSnapshot.hostPos.x, latestSnapshot.hostPos.z, latestSnapshot.hostYaw);

        let collectedCount = 0;
        latestSnapshot.collected.forEach((isCollected, i) => {
          const mesh = itemMeshes[i];
          if (isCollected) {
            collectedCount++;
            if (!mesh.userData.collected) {
              mesh.userData.collected = true;
              scene.remove(mesh);
            }
          }
        });
        if (collectedCount !== state.collected) {
          state.collected = collectedCount;
          itemCounter.textContent = `${state.collected} / ${state.total}`;
          updateObjectiveText();
        }
        if (latestSnapshot.doorOpen) openDoor();
        if (latestSnapshot.gameOver && !state.gameOverFired) {
          state.gameOverFired = true;
          gameOver();
        }
        if (latestSnapshot.win && !state.winFired) {
          state.winFired = true;
          win();
        }

        const localDist = Math.hypot(m.x - player.pos.x, m.z - player.pos.z);
        const aggroT = m.aggro / 100;
        const proximity = 1 - Math.min(localDist, 22) / 22;
        audio.setHeartbeatIntensity(Math.min(1, aggroT * 0.85 + proximity * 0.2));
      }
    } else {
      // Solo or host: authoritative simulation.
      for (const mesh of itemMeshes) {
        if (mesh.userData.collected) continue;
        animateItem(mesh, dt);
        const dHost = Math.hypot(mesh.position.x - player.pos.x, mesh.position.z - player.pos.z);
        const dGuest = remoteConnected
          ? Math.hypot(mesh.position.x - remoteState.pos.x, mesh.position.z - remoteState.pos.z)
          : Infinity;
        if (Math.min(dHost, dGuest) < 1.0) {
          mesh.userData.collected = true;
          scene.remove(mesh);
          state.collected++;
          itemCounter.textContent = `${state.collected} / ${state.total}`;
          showPickupToast(`Found a photograph - ${mesh.userData.roomName}`);
          updateObjectiveText();
          if (state.collected >= state.total) openDoor();
        }
      }

      const hostCell = worldToCell(player.pos.x, player.pos.z);
      const atDoor =
        hostCell.x === DOOR_CELL.x && hostCell.z === DOOR_CELL.z
          ? true
          : remoteConnected &&
            (() => {
              const gc = worldToCell(remoteState.pos.x, remoteState.pos.z);
              return gc.x === DOOR_CELL.x && gc.z === DOOR_CELL.z;
            })();
      if (state.collected >= state.total && atDoor) win();

      const players = [player];
      if (remoteConnected) {
        players.push({
          pos: remoteState.pos,
          isMoving: remoteState.isMoving,
          isRunning: remoteState.isRunning,
          flashlightOn: remoteState.flashlightOn,
          noiseRadius: remoteState.noiseRadius,
        });
      }
      const result = monster.update(dt, players);

      const aggroT = result.aggro / 100;
      const localDist = Math.hypot(monster.pos.x - player.pos.x, monster.pos.z - player.pos.z);
      const proximity = 1 - Math.min(localDist, 22) / 22;
      audio.setHeartbeatIntensity(Math.min(1, aggroT * 0.85 + proximity * 0.2));

      if (remoteConnected) {
        remotePlayer.updateFromState(remoteState.pos.x, remoteState.pos.z, remoteState.yaw);
      }

      if (mode === "host" && sendNow) sendSnapshot();
    }

    flashlight.intensity = player.flashlightOn ? 100 : 0;
    staminaBar.style.width = `${player.stamina * 100}%`;
    batteryBar.style.width = `${player.flashlightBattery * 100}%`;
  }

  renderer.render(scene, camera);
}
tick();

if (window.__EXPOSE_TEST_HOOKS__) {
  window.__test = {
    state,
    win,
    gameOver,
    player,
    monster,
    itemMeshes,
    network,
    remotePlayer,
    get mode() {
      return mode;
    },
    get remoteState() {
      return remoteState;
    },
    get remoteConnected() {
      return remoteConnected;
    },
    get latestSnapshot() {
      return latestSnapshot;
    },
  };
}
