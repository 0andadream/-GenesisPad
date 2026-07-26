import * as THREE from "three";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const canvas = document.querySelector("[data-sculpture]");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (canvas && !reduceMotion) {
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = innerWidth > 780;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, .1, 100);
    camera.position.set(0, .1, 8);

    const marble = new THREE.MeshStandardMaterial({ color: 0xe5e5e1, roughness: .72, metalness: .02 });
    const shadowMarble = new THREE.MeshStandardMaterial({ color: 0xb7b7b3, roughness: .88 });
    const sculpture = new THREE.Group();
    sculpture.position.set(2.25, -.25, 0);
    scene.add(sculpture);

    const addPart = (geometry, position, scale = [1, 1, 1], material = marble) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position); mesh.scale.set(...scale);
      mesh.castShadow = true; mesh.receiveShadow = true;
      sculpture.add(mesh); return mesh;
    };

    addPart(new THREE.IcosahedronGeometry(1.15, 5), [0, .95, 0], [.76, 1.05, .78]);
    addPart(new THREE.CapsuleGeometry(.42, .78, 10, 24), [0, -.3, 0], [1, 1, .88]);
    addPart(new THREE.SphereGeometry(1.9, 48, 28, 0, Math.PI * 2, 0, Math.PI * .5), [0, -1.35, 0], [1.2, .55, .5]);
    addPart(new THREE.ConeGeometry(.2, .58, 18), [0, .88, .82], [.72, .82, .72], shadowMarble).rotation.x = Math.PI / 2;
    addPart(new THREE.TorusGeometry(.14, .035, 10, 28, Math.PI), [-.34, 1.13, .76], [1, .55, 1], shadowMarble);
    addPart(new THREE.TorusGeometry(.14, .035, 10, 28, Math.PI), [.34, 1.13, .76], [1, .55, 1], shadowMarble);

    const curls = new THREE.Group();
    for (let i = 0; i < 42; i++) {
      const angle = (i / 42) * Math.PI * 2;
      const ring = i % 3;
      const curl = new THREE.Mesh(new THREE.IcosahedronGeometry(.19 + ring * .025, 2), shadowMarble);
      curl.position.set(Math.cos(angle) * (.72 + ring * .12), 1.48 + Math.sin(i * 2.1) * .25, Math.sin(angle) * .62);
      curls.add(curl);
    }
    sculpture.add(curls);

    const fragments = new THREE.Group();
    const fragmentData = [];
    const fragmentGeometry = new THREE.TetrahedronGeometry(.11, 1);
    for (let i = 0; i < 150; i++) {
      const mesh = new THREE.Mesh(fragmentGeometry, i % 4 ? marble : shadowMarble);
      const theta = Math.random() * Math.PI * 2;
      const radius = 1 + Math.random() * 1.5;
      const origin = new THREE.Vector3(Math.cos(theta) * radius * .55, Math.random() * 3.4 - 1.5, Math.sin(theta) * radius * .4);
      mesh.position.copy(origin);
      mesh.scale.setScalar(.35 + Math.random() * 1.4);
      fragments.add(mesh);
      fragmentData.push({ mesh, origin, burst: new THREE.Vector3((Math.random() - .5) * 8, (Math.random() - .5) * 7, (Math.random() - .5) * 5), spin: Math.random() * 6 });
    }
    fragments.position.copy(sculpture.position);
    scene.add(fragments);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 4.2);
    key.position.set(4, 6, 5); key.castShadow = true; scene.add(key);
    const rim = new THREE.DirectionalLight(0x9b9b9b, 2.1);
    rim.position.set(-5, 1, -3); scene.add(rim);

    const pointer = new THREE.Vector2();
    window.addEventListener("pointermove", (event) => {
      pointer.x = event.clientX / innerWidth - .5;
      pointer.y = event.clientY / innerHeight - .5;
    }, { passive: true });

    const state = { progress: 0 };
    ScrollTrigger.create({
      trigger: "main", start: "top top", end: "bottom bottom", scrub: .5,
      onUpdate: ({ progress }) => { state.progress = progress; }
    });

    function resize() {
      camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight, false);
      sculpture.position.x = innerWidth < 850 ? 1.25 : 2.25;
      fragments.position.copy(sculpture.position);
    }
    resize(); addEventListener("resize", resize);

    const clock = new THREE.Clock();
    function render() {
      const time = clock.getElapsedTime();
      const cycle = state.progress * 4;
      const phase = cycle % 1;
      const fracture = Math.sin(phase * Math.PI);
      const section = Math.floor(cycle);
      sculpture.rotation.y += ((pointer.x * .22 + section * .42) - sculpture.rotation.y) * .035;
      sculpture.rotation.x += ((-pointer.y * .1) - sculpture.rotation.x) * .025;
      sculpture.position.y = -.25 + Math.sin(time * .35) * .035;
      key.position.x = 4 + pointer.x * 5;
      key.position.y = 6 - pointer.y * 3;
      sculpture.children.forEach((part, index) => {
        if (part === curls) return;
        part.scale.setScalar(1 - fracture * .16);
        part.rotation.z = fracture * (index - 2) * .06;
      });
      fragments.visible = fracture > .025;
      fragmentData.forEach(({ mesh, origin, burst, spin }, index) => {
        mesh.position.copy(origin).lerp(burst, fracture);
        mesh.rotation.set(time * .14 + fracture * spin, time * .1 + index, fracture * spin);
        mesh.scale.setScalar((.3 + (index % 7) * .08) * fracture);
      });
      fragments.rotation.y = -sculpture.rotation.y * .35;
      renderer.render(scene, camera);
      requestAnimationFrame(render);
    }
    render();
  } catch (error) {
    document.documentElement.classList.add("no-webgl");
    console.error("Genesis sculpture scene unavailable", error);
  }
}
