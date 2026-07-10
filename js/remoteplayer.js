import * as THREE from "../vendor/three.module.js";

// A simple, visible stand-in for the other player - not trying to be a
// detailed character model, just something readable in the dark that
// reads clearly as "person, not monster."
export function buildRemotePlayerMesh() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.6, emissive: 0x0b1a2b, emissiveIntensity: 0.4 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.05, 4, 8), mat);
  body.position.y = 1.0;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), mat);
  head.position.y = 1.75;
  group.add(head);

  const marker = new THREE.PointLight(0x5a9bd8, 3, 3);
  marker.position.y = 2.1;
  group.add(marker);

  return group;
}

export class RemotePlayer {
  constructor(scene) {
    this.mesh = buildRemotePlayerMesh();
    this.visible = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.lastUpdate = 0;
  }

  updateFromState(x, z, yaw) {
    this.mesh.position.set(x, 0, z);
    this.mesh.rotation.y = yaw;
    if (!this.visible) {
      this.visible = true;
      this.mesh.visible = true;
    }
    this.lastUpdate = performance.now();
  }

  // Hide the avatar if we haven't heard from the other player in a while
  // (disconnect, tab backgrounded, etc.) rather than leaving a stale
  // statue standing in the house.
  checkStale() {
    if (this.visible && performance.now() - this.lastUpdate > 5000) {
      this.visible = false;
      this.mesh.visible = false;
    }
  }
}
