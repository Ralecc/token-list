// Her side of the video call: a VRM model rendered with three.js, framed like a
// webcam shot, with breathing, head motion, blinking, eye contact, facial
// expressions and lip sync driven by her voice.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const EMOTIONS = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];
const INTENSITY = { happy: 0.6, sad: 0.65, angry: 0.55, surprised: 0.7, relaxed: 0.6 };
const EMOTION_HOLD = 6; // seconds an expression lingers after she last used it
const BLINK_TIME = 0.16;

// Smooth, non-repeating wobble in roughly [-1, 1].
const wobble = (t, seed) =>
  0.6 * Math.sin(t + seed * 1.7) + 0.3 * Math.sin(t * 2.3 + seed * 3.1) + 0.1 * Math.sin(t * 4.1 + seed * 5.3);
// Frame-rate independent easing towards a target.
const damp = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));

export class Avatar {
  vrm = null;
  #mood = 'idle';
  #thinking = 0;
  #emotion = 'neutral';
  #emotionUntil = 0;
  #weights = {};
  #mouth = { aa: 0, oh: 0, ee: 0 };
  #blink = { wait: 2, t: -1 };
  #face = new THREE.Vector3(0, 1.35, 0);
  #last = performance.now() / 1000;
  #loads = 0;

  constructor(canvas, { mouth, orb }) {
    this.canvas = canvas;
    this.getMouth = mouth;
    this.orb = orb;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
    this.scene.add(this.camera);

    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.85);
    key.position.set(0.5, 1.5, 2);
    this.scene.add(key, new THREE.HemisphereLight(0xffe4ef, 0x2a2035, 1.2));

    // Her eyes follow this point, which rides along with the camera: you.
    this.gaze = new THREE.Object3D();
    this.camera.add(this.gaze);

    new ResizeObserver(() => this.#resize()).observe(canvas);
    this.#resize();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  async load(url, onProgress) {
    const load = ++this.#loads;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('this file has no VRM data');
    if (load !== this.#loads) return VRMUtils.deepDispose(gltf.scene); // a newer avatar was requested meanwhile

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.combineMorphs(vrm);
    VRMUtils.rotateVRM0(vrm); // older VRM 0.x models face the other way
    vrm.scene.traverse((obj) => (obj.frustumCulled = false));

    this.unload();
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;
    this.#pose(0, 0);
    vrm.update(0);

    const head = vrm.humanoid.getRawBoneNode('head');
    if (head) head.getWorldPosition(this.#face).add(new THREE.Vector3(0, 0.06, 0));
    this.#frameCamera();
  }

  unload() {
    if (!this.vrm) return;
    this.scene.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }

  setEmotion(name) {
    if (!EMOTIONS.includes(name)) {
      this.#emotionUntil = 0;
      return;
    }
    this.#emotion = name;
    this.#emotionUntil = performance.now() / 1000 + EMOTION_HOLD;
  }

  // idle | connecting | listening | thinking | speaking | ...
  setMood(mood) {
    this.#mood = mood;
  }

  #resize() {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.#frameCamera();
  }

  // Head and shoulders, like a webcam: fit ~0.62 m of height and at least ~0.36 m
  // of width (on tall phone screens the shoulders get cropped, as in a real call).
  #frameCamera() {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max(0.62 / (2 * tan), 0.36 / (2 * tan * this.camera.aspect));
    const visibleHeight = 2 * distance * tan;
    const { x, y, z } = this.#face;
    this.camera.position.set(x, y - 0.03, z + distance);
    this.camera.lookAt(x, y - visibleHeight * 0.18, z);
    this.camera.updateProjectionMatrix();
  }

  #frame() {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - this.#last);
    this.#last = now;
    const mouth = this.getMouth?.(now);

    if (this.vrm) {
      this.#animate(now, dt, mouth);
      this.vrm.update(dt);
    } else if (this.orb) {
      this.orb.style.setProperty('--level', (mouth?.open ?? 0).toFixed(3));
    }
    this.renderer.render(this.scene, this.camera);
  }

  #animate(t, dt, mouth) {
    const faces = this.vrm.expressionManager;

    // Lip sync: loudness opens the jaw, the spectrum decides between round and wide shapes.
    const open = mouth?.open ?? 0;
    this.#mouth.aa = damp(this.#mouth.aa, open * 0.85, 18, dt);
    this.#mouth.oh = damp(this.#mouth.oh, open * Math.max(0, (mouth?.round ?? 0) - 0.55) * 1.6, 18, dt);
    this.#mouth.ee = damp(this.#mouth.ee, open * Math.max(0, (mouth?.wide ?? 0) - 0.35) * 1.2, 18, dt);

    this.#thinking = damp(this.#thinking, this.#mood === 'thinking' ? 1 : 0, 3, dt);
    this.#pose(t, this.#mouth.aa);
    // While thinking she glances up and to the side, otherwise she looks at you.
    this.gaze.position.set(this.#thinking * 0.35, this.#thinking * 0.3, 0);

    const active = t < this.#emotionUntil ? this.#emotion : 'neutral';
    for (const name of EMOTIONS) {
      this.#weights[name] = damp(this.#weights[name] ?? 0, name === active ? INTENSITY[name] : 0, 4, dt);
      faces?.setValue(name, this.#weights[name]);
    }

    const blink = this.#blinkAmount(dt);
    // Smiling expressions usually squint already; don't blink through them.
    const squint = Math.max(this.#weights.happy, this.#weights.relaxed);
    faces?.setValue('blink', blink * (1 - squint));
    faces?.setValue('aa', this.#mouth.aa);
    faces?.setValue('oh', this.#mouth.oh);
    faces?.setValue('ee', this.#mouth.ee);
  }

  // Relaxed standing pose with breathing and a slowly wandering head.
  #pose(t, talking) {
    const bone = (name) => this.vrm.humanoid.getNormalizedBoneNode(name);
    const set = (name, x, y, z) => bone(name)?.rotation.set(x, y, z);
    const breath = Math.sin(t * 1.7);
    const think = this.#thinking;

    set('hips', 0, wobble(t * 0.15, 8) * 0.02, wobble(t * 0.12, 9) * 0.01);
    set('spine', breath * 0.012, wobble(t * 0.2, 1) * 0.03, 0);
    set('chest', breath * 0.015, 0, 0);
    set('neck', wobble(t * 0.3, 2) * 0.03 + talking * 0.03 * Math.sin(t * 7), wobble(t * 0.25, 3) * 0.05, 0);
    set(
      'head',
      wobble(t * 0.4, 5) * 0.04 - think * 0.08,
      wobble(t * 0.35, 6) * 0.06 + think * 0.12,
      wobble(t * 0.3, 7) * 0.04 + think * 0.08,
    );
    set('leftUpperArm', 0, 0, -1.2 - breath * 0.01);
    set('rightUpperArm', 0, 0, 1.2 + breath * 0.01);
    set('leftLowerArm', 0, -0.3, 0);
    set('rightLowerArm', 0, 0.3, 0);
  }

  #blinkAmount(dt) {
    const blink = this.#blink;
    blink.wait -= dt;
    if (blink.t < 0 && blink.wait <= 0) blink.t = 0;
    if (blink.t < 0) return 0;
    blink.t += dt;
    if (blink.t >= BLINK_TIME) {
      blink.t = -1;
      blink.wait = 1.5 + Math.random() * 4.5;
      return 0;
    }
    const half = BLINK_TIME / 2;
    return blink.t < half ? blink.t / half : 2 - blink.t / half;
  }
}
