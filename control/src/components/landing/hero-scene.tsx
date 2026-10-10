"use client";

/**
 * Hero motion graphic (three.js via @react-three/fiber), rendered on a TRANSPARENT canvas — no clear colour, so the
 * page gradient shows through. Story, left → right:
 *   Git node ──code cubes──▶ build ring ──▶ globe of edge nodes        + a database cylinder emitting realtime pulses
 * Glow is faked with additive sprites (no post-processing pass). Loaded with next/dynamic({ ssr: false }) only.
 */
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdaptiveDpr, Float } from "@react-three/drei";
import * as THREE from "three";

export type SceneTheme = "dark" | "light";

type Palette = { fg: THREE.Color; accent: THREE.Color; soft: THREE.Color; blending: THREE.Blending; glow: number };
function palette(theme: SceneTheme): Palette {
  return theme === "light"
    ? { fg: new THREE.Color("#171717"), accent: new THREE.Color("#0070f3"), soft: new THREE.Color("#8f8f8f"), blending: THREE.NormalBlending, glow: 0.45 }
    : { fg: new THREE.Color("#ededed"), accent: new THREE.Color("#3291ff"), soft: new THREE.Color("#5a6b80"), blending: THREE.AdditiveBlending, glow: 1 };
}

// Anchor points of the composition (world units).
const GIT = new THREE.Vector3(-4.6, 0.35, 0);
const RING = new THREE.Vector3(-0.9, 0, 0);
const GLOBE = new THREE.Vector3(3.3, 0.2, -0.4);
const DB = new THREE.Vector3(1.0, -2.05, 0.6);
const GLOBE_R = 1.55;

/** Radial-gradient texture for the fake bloom sprites (generated once). */
let glowTex: THREE.Texture | null = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, "rgba(255,255,255,.55)");
  grd.addColorStop(0.5, "rgba(255,255,255,.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

function Glow({ position, color, scale, opacity, p }: { position: THREE.Vector3 | [number, number, number]; color: THREE.Color; scale: number; opacity: number; p: Palette }) {
  const tex = useMemo(() => glowTexture(), []);
  return (
    <sprite position={position as THREE.Vector3} scale={[scale, scale, 1]}>
      <spriteMaterial map={tex} color={color} transparent opacity={opacity * p.glow} blending={p.blending} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

/** The path the code cubes travel: git → through the ring → into the globe. */
function usePath() {
  return useMemo(
    () =>
      new THREE.CatmullRomCurve3(
        [GIT.clone(), new THREE.Vector3(-2.9, 1.05, 0.4), RING.clone().add(new THREE.Vector3(-0.35, 0, 0)), RING.clone().add(new THREE.Vector3(0.45, 0, 0)), new THREE.Vector3(1.4, 0.75, 0.2), GLOBE.clone()],
        false,
        "centripetal",
      ),
    [],
  );
}

function PathLine({ curve, p }: { curve: THREE.CatmullRomCurve3; p: Palette }) {
  const geo = useMemo(() => new THREE.BufferGeometry().setFromPoints(curve.getPoints(160)), [curve]);
  const line = useMemo(() => {
    const l = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: p.soft, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.7 }));
    l.computeLineDistances();
    return l;
  }, [geo, p]);
  return <primitive object={line} />;
}

/** Instanced code cubes moving along the path; they turn accent-blue after passing through the build ring. */
function CodeCubes({ curve, p, count = 16 }: { curve: THREE.CatmullRomCurve3; p: Palette; count?: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const edges = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const ringT = 0.5; // approx. curve parameter at the ring
  useFrame(({ clock }) => {
    const t0 = clock.getElapsedTime();
    for (let i = 0; i < count; i++) {
      const t = (t0 * 0.075 + i / count) % 1;
      const pos = curve.getPointAt(t);
      const s = Math.min(1, t * 9) * Math.min(1, (1 - t) * 7) * (t > ringT ? 0.85 : 1);
      dummy.position.copy(pos);
      dummy.rotation.set(t0 * 0.9 + i, t0 * 1.3 + i * 0.5, 0);
      dummy.scale.setScalar(0.17 * s);
      dummy.updateMatrix();
      mesh.current?.setMatrixAt(i, dummy.matrix);
      edges.current?.setMatrixAt(i, dummy.matrix);
      const k = THREE.MathUtils.smoothstep(t, ringT - 0.04, ringT + 0.04);
      color.copy(p.fg).lerp(p.accent, k);
      mesh.current?.setColorAt(i, color);
    }
    if (mesh.current) {
      mesh.current.instanceMatrix.needsUpdate = true;
      if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    }
    if (edges.current) edges.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={mesh} args={[undefined, undefined, count]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial transparent opacity={0.85} blending={p.blending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={edges} args={[undefined, undefined, count]} scale={1}>
        <boxGeometry args={[1.35, 1.35, 1.35]} />
        <meshBasicMaterial color={p.accent} wireframe transparent opacity={0.25} blending={p.blending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
    </>
  );
}

function GitNode({ p }: { p: Palette }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (g.current) g.current.rotation.y += dt * 0.6;
  });
  return (
    <Float speed={1.4} rotationIntensity={0.2} floatIntensity={0.35}>
      <group position={GIT}>
        <group ref={g}>
          <mesh>
            <octahedronGeometry args={[0.55, 0]} />
            <meshBasicMaterial color={p.fg} wireframe transparent opacity={0.9} blending={p.blending} toneMapped={false} />
          </mesh>
          <mesh>
            <octahedronGeometry args={[0.3, 0]} />
            <meshBasicMaterial color={p.accent} transparent opacity={0.9} blending={p.blending} toneMapped={false} />
          </mesh>
        </group>
        {/* branch stubs */}
        {[-1, 1].map((d) => (
          <mesh key={d} position={[-0.75, d * 0.55, 0]}>
            <sphereGeometry args={[0.07, 12, 12]} />
            <meshBasicMaterial color={p.soft} toneMapped={false} />
          </mesh>
        ))}
        <Glow position={[0, 0, 0]} color={p.accent} scale={2.6} opacity={0.55} p={p} />
      </group>
    </Float>
  );
}

function BuildRing({ p }: { p: Palette }) {
  const outer = useRef<THREE.Mesh>(null);
  const inner = useRef<THREE.Group>(null);
  const ticks = useMemo(() => Array.from({ length: 24 }, (_, i) => (i / 24) * Math.PI * 2), []);
  useFrame(({ clock }, dt) => {
    if (outer.current) outer.current.rotation.z += dt * 0.35;
    if (inner.current) {
      inner.current.rotation.z -= dt * 0.9;
      const s = 1 + Math.sin(clock.getElapsedTime() * 2.2) * 0.03;
      inner.current.scale.setScalar(s);
    }
  });
  return (
    <group position={RING} rotation={[0, Math.PI / 2.6, 0]}>
      <mesh ref={outer}>
        <torusGeometry args={[1.05, 0.035, 12, 96]} />
        <meshBasicMaterial color={p.accent} transparent opacity={0.95} blending={p.blending} toneMapped={false} />
      </mesh>
      <group ref={inner}>
        {ticks.map((a, i) => (
          <mesh key={i} position={[Math.cos(a) * 0.82, Math.sin(a) * 0.82, 0]} rotation={[0, 0, a]}>
            <boxGeometry args={[i % 3 === 0 ? 0.16 : 0.08, 0.025, 0.025]} />
            <meshBasicMaterial color={i % 3 === 0 ? p.accent : p.fg} transparent opacity={i % 3 === 0 ? 1 : 0.55} blending={p.blending} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <mesh>
        <torusGeometry args={[1.32, 0.008, 6, 128]} />
        <meshBasicMaterial color={p.fg} transparent opacity={0.3} blending={p.blending} toneMapped={false} />
      </mesh>
      <Glow position={[0, 0, 0]} color={p.accent} scale={3.6} opacity={0.35} p={p} />
    </group>
  );
}

/** Fibonacci-distributed edge nodes on a wireframe globe, twinkling; a few arcs between them. */
function Globe({ p }: { p: Palette }) {
  const g = useRef<THREE.Group>(null);
  const nodes = useMemo(() => {
    const n = 46;
    const pts: THREE.Vector3[] = [];
    const phi = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = phi * i;
      pts.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r).multiplyScalar(GLOBE_R));
    }
    return pts;
  }, []);
  const pointsGeo = useMemo(() => new THREE.BufferGeometry().setFromPoints(nodes), [nodes]);
  const arcs = useMemo(() => {
    const pairs: [number, number][] = [[3, 17], [8, 29], [12, 40], [21, 33], [5, 44], [26, 9]];
    return pairs.map(([a, b]) => {
      const A = nodes[a], B = nodes[b];
      const mid = A.clone().add(B).multiplyScalar(0.5).normalize().multiplyScalar(GLOBE_R * 1.45);
      const c = new THREE.QuadraticBezierCurve3(A, mid, B);
      const geo = new THREE.BufferGeometry().setFromPoints(c.getPoints(40));
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: p.accent, transparent: true, opacity: 0.45, blending: p.blending, depthWrite: false }));
    });
  }, [nodes, p]);
  const ptsMat = useRef<THREE.PointsMaterial>(null);
  useFrame(({ clock }, dt) => {
    if (g.current) g.current.rotation.y += dt * 0.18;
    if (ptsMat.current) ptsMat.current.size = 0.17 + Math.sin(clock.getElapsedTime() * 3) * 0.03;
  });
  const tex = useMemo(() => glowTexture(), []);
  return (
    <group position={GLOBE} rotation={[0.35, 0, 0.12]}>
      <group ref={g}>
        <mesh>
          <icosahedronGeometry args={[GLOBE_R, 3]} />
          <meshBasicMaterial color={p.soft} wireframe transparent opacity={0.28} blending={p.blending} depthWrite={false} toneMapped={false} />
        </mesh>
        <points geometry={pointsGeo}>
          <pointsMaterial ref={ptsMat} map={tex} color={p.accent} size={0.18} sizeAttenuation transparent depthWrite={false} blending={p.blending} toneMapped={false} />
        </points>
        {arcs.map((line, i) => (
          <primitive key={i} object={line} />
        ))}
      </group>
      {/* equator ring */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[GLOBE_R * 1.22, 0.006, 6, 128]} />
        <meshBasicMaterial color={p.fg} transparent opacity={0.35} blending={p.blending} toneMapped={false} />
      </mesh>
      <Glow position={[0, 0, 0]} color={p.accent} scale={5} opacity={0.22} p={p} />
    </group>
  );
}

/** Stacked database cylinder with expanding "realtime" pulse rings and a beam up to the globe. */
function Database({ p }: { p: Palette }) {
  const pulses = useRef<THREE.Mesh[]>([]);
  const beam = useRef<THREE.Mesh>(null);
  const N = 3;
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    pulses.current.forEach((m, i) => {
      if (!m) return;
      const k = (t * 0.45 + i / N) % 1;
      m.scale.setScalar(0.6 + k * 2.2);
      (m.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.7;
    });
    if (beam.current) (beam.current.material as THREE.MeshBasicMaterial).opacity = 0.18 + (Math.sin(t * 4) * 0.5 + 0.5) * 0.25;
  });
  const beamGeo = useMemo(() => {
    const from = DB.clone().add(new THREE.Vector3(0, 0.45, 0));
    const to = GLOBE.clone().add(new THREE.Vector3(-0.9, -1.05, 0.2));
    const c = new THREE.QuadraticBezierCurve3(from, new THREE.Vector3((from.x + to.x) / 2, from.y + 0.2, 0.4), to);
    return new THREE.TubeGeometry(c, 40, 0.012, 6, false);
  }, []);
  return (
    <>
      <Float speed={1.1} rotationIntensity={0.08} floatIntensity={0.25}>
        <group position={DB} rotation={[0.28, 0, 0]}>
          {[0, 1, 2].map((i) => (
            <group key={i} position={[0, i * 0.3 - 0.3, 0]}>
              <mesh>
                <cylinderGeometry args={[0.5, 0.5, 0.22, 40, 1, true]} />
                <meshBasicMaterial color={p.fg} transparent opacity={0.08} side={THREE.DoubleSide} blending={p.blending} depthWrite={false} toneMapped={false} />
              </mesh>
              {[-0.11, 0.11].map((y) => (
                <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
                  <torusGeometry args={[0.5, 0.012, 6, 64]} />
                  <meshBasicMaterial color={i === 2 && y > 0 ? p.accent : p.fg} transparent opacity={0.85} blending={p.blending} toneMapped={false} />
                </mesh>
              ))}
            </group>
          ))}
          {Array.from({ length: N }, (_, i) => (
            <mesh
              key={i}
              ref={(m) => {
                if (m) pulses.current[i] = m;
              }}
              position={[0, 0.22, 0]}
              rotation={[Math.PI / 2, 0, 0]}
            >
              <torusGeometry args={[0.5, 0.01, 6, 72]} />
              <meshBasicMaterial color={p.accent} transparent opacity={0.5} blending={p.blending} depthWrite={false} toneMapped={false} />
            </mesh>
          ))}
          <Glow position={[0, 0.1, 0]} color={p.accent} scale={2.4} opacity={0.4} p={p} />
        </group>
      </Float>
      <mesh ref={beam} geometry={beamGeo}>
        <meshBasicMaterial color={p.accent} transparent opacity={0.3} blending={p.blending} depthWrite={false} toneMapped={false} />
      </mesh>
    </>
  );
}

function Dust({ p, count = 220 }: { p: Palette; count?: number }) {
  const ref = useRef<THREE.Points>(null);
  const geo = useMemo(() => {
    const arr = new Float32Array(count * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (rnd() - 0.5) * 16;
      arr[i * 3 + 1] = (rnd() - 0.5) * 7;
      arr[i * 3 + 2] = (rnd() - 0.5) * 6 - 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    return g;
  }, [count]);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.02;
  });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial color={p.soft} size={0.025} sizeAttenuation transparent opacity={0.8} depthWrite={false} blending={p.blending} toneMapped={false} />
    </points>
  );
}

/** Mouse parallax + aspect-aware camera distance so the whole pipeline fits on phones. */
function Rig({ children, pointer }: { children: React.ReactNode; pointer: React.RefObject<{ x: number; y: number }> }) {
  const g = useRef<THREE.Group>(null);
  const { camera, size } = useThree();
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const persp = camera as THREE.PerspectiveCamera;
    persp.position.set(0, 0.2, Math.max(9.4, 19 / aspect));
    persp.lookAt(0, -0.65, 0);
    persp.updateProjectionMatrix();
  }, [camera, size]);
  useFrame(({ clock }) => {
    if (!g.current) return;
    const t = clock.getElapsedTime();
    const px = pointer.current?.x ?? 0;
    const py = pointer.current?.y ?? 0;
    g.current.rotation.y = THREE.MathUtils.lerp(g.current.rotation.y, px * 0.22 + Math.sin(t * 0.15) * 0.05, 0.05);
    g.current.rotation.x = THREE.MathUtils.lerp(g.current.rotation.x, -py * 0.12, 0.05);
  });
  return <group ref={g}>{children}</group>;
}

function FirstFrame({ onReady }: { onReady?: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (!done.current) {
      done.current = true;
      requestAnimationFrame(() => onReady?.());
    }
  });
  return null;
}

export default function HeroScene({ theme, paused, onReady }: { theme: SceneTheme; paused?: boolean; onReady?: () => void }) {
  const p = useMemo(() => palette(theme), [theme]);
  const curve = usePath();
  const pointer = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);
  return (
    <Canvas
      aria-hidden
      role="presentation"
      tabIndex={-1}
      frameloop={paused ? "never" : "always"}
      dpr={[1, 1.75]}
      camera={{ fov: 40, near: 0.1, far: 60, position: [0, 0.4, 9.5] }}
      gl={{ alpha: true, antialias: true, powerPreference: "high-performance", premultipliedAlpha: true, preserveDrawingBuffer: false }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      style={{ background: "transparent", pointerEvents: "none" }}
    >
      <AdaptiveDpr pixelated={false} />
      <FirstFrame onReady={onReady} />
      <Rig pointer={pointer}>
        <Dust p={p} />
        <PathLine curve={curve} p={p} />
        <CodeCubes curve={curve} p={p} />
        <GitNode p={p} />
        <BuildRing p={p} />
        <Globe p={p} />
        <Database p={p} />
      </Rig>
    </Canvas>
  );
}
