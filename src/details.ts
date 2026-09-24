import * as THREE from 'three';
import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type Map as GLMap,
  type CustomRenderMethodInput,
} from 'maplibre-gl';
import type { ModelResult } from './model';
interface Chunk {
  group: THREE.Group;
  model: ModelResult;
  origin: [number, number];
}
export class Details implements CustomLayerInterface {
  id = 'models';
  type = 'custom' as const;
  renderingMode = '3d' as const;
  scene = new THREE.Scene();
  camera = new THREE.Camera();
  renderer!: THREE.WebGLRenderer;
  map!: GLMap;
  group = new THREE.Group();
  origin: [number, number] = [0, 0];
  visible = true;
  chunks = new Map<string, Chunk>();
  active = new Set<string>();
  allocations = 0;
  removals = 0;
  terrainTimer: ReturnType<typeof setTimeout> | undefined;
  stats: ModelResult['stats'] | null = null;
  onAdd(map: GLMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl as WebGL2RenderingContext,
      antialias: true,
    });
    this.renderer.autoClear = false;
    this.scene.add(new THREE.AmbientLight('#f3f3ec', 1.25));
    const light = new THREE.DirectionalLight('#fff1d8', 2.1);
    light.position.set(-200, -400, 700);
    this.scene.add(light);
    const fill = new THREE.DirectionalLight('#dce7ef', 0.65);
    fill.position.set(300, 200, 400);
    this.scene.add(fill);

    map.on('sourcedata', this.terrainChanged);
  }
  remove(key: string) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.scene.remove(chunk.group);
    for (const child of chunk.group.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material?.dispose();
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
    this.chunks.delete(key);
    if (this.group === chunk.group) this.group = new THREE.Group();
    this.removals++;
  }
  clear() {
    for (const key of [...this.chunks.keys()]) this.remove(key);
    this.active.clear();
    this.stats = null;
    this.map?.triggerRepaint();
  }
  activate(keys: Iterable<string>) {
    const next = new Set(keys);
    if (next.size === this.active.size && [...next].every((k) => this.active.has(k))) return;
    this.active = next;
    for (const [key, chunk] of this.chunks) chunk.group.visible = this.active.has(key);
    this.alignTerrain();
    this.map?.triggerRepaint();
  }
  update(key: string, data: ModelResult, origin: [number, number]) {
    if (this.chunks.has(key)) return;
    if (!this.chunks.size) this.origin = origin;
    const group = new THREE.Group();
    this.group = group;
    const anchor = MercatorCoordinate.fromLngLat(this.origin),
      coordinate = MercatorCoordinate.fromLngLat(origin),
      scale = anchor.meterInMercatorCoordinateUnits(),
      relativeScale = coordinate.meterInMercatorCoordinateUnits() / scale;
    group.position.set((coordinate.x - anchor.x) / scale, -(coordinate.y - anchor.y) / scale, 0);
    group.scale.setScalar(relativeScale);
    group.visible = this.active.has(key);
    this.scene.add(group);
    this.chunks.set(key, { group, model: data, origin });
    this.allocations++;
    this.stats = data.stats;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        flatShading: true,
        side: THREE.DoubleSide,
      }),
    );
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const trees = data.trees,
      make = (g: THREE.BufferGeometry, color: string) => {
        g.rotateX(Math.PI / 2);
        const m = new THREE.InstancedMesh(
          g,
          new THREE.MeshLambertMaterial({ color, flatShading: true }),
          trees.length,
        );
        m.frustumCulled = false;
        this.group.add(m);
        return m;
      };
    const trunks = make(new THREE.CylinderGeometry(0.18, 0.28, 1, 5), '#7c705b'),
      leaves = make(new THREE.IcosahedronGeometry(1, 1), '#74915c'),
      cones = make(new THREE.ConeGeometry(1, 1, 7), '#476e53');
    let li = 0,
      ci = 0;
    const dummy = new THREE.Object3D(),
      color = new THREE.Color();
    trees.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z + t.height * 0.22);
      dummy.scale.set(1, 1, t.height * 0.44);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x, t.y, t.z + t.height * 0.65);
      dummy.scale.set(t.radius, t.radius, t.height * (t.conifer ? 0.75 : 0.38));
      dummy.updateMatrix();
      const m = t.conifer ? cones : leaves,
        k = t.conifer ? ci++ : li++;
      m.setMatrixAt(k, dummy.matrix);
      color.setHSL(t.conifer ? 0.36 : 0.27, 0.2, 0.35 + (t.seed % 11) / 100);
      m.setColorAt(k, color);
    });
    leaves.count = li;
    cones.count = ci;
    for (const m of [trunks, leaves, cones]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.alignTerrain();
    this.map.triggerRepaint();
  }
  private terrainChanged = (event: { sourceId?: string }) => {
    if (event.sourceId !== 'dem') return;
    clearTimeout(this.terrainTimer);
    this.terrainTimer = setTimeout(() => this.alignTerrain(), 200);
  };
  private alignTerrain() {
    if (!this.chunks.size) return;
    for (const [key, chunk] of this.chunks) {
      if (!this.active.has(key)) continue;
      const terrainComplete = this.map.isSourceLoaded('dem');
      const model = chunk.model;
      let changed = false;
      const mesh = chunk.group.children[0] as THREE.Mesh;
      for (const span of model.spans) {
        const z = this.map.queryTerrainElevation([span.lon, span.lat]);
        if (
          z === null ||
          !Number.isFinite(z) ||
          (z === 0 && Math.abs(span.base) > 5 && !terrainComplete)
        )
          continue;
        const next = z - span.base,
          delta = next - span.offset;
        if (Math.abs(delta) < 0.03) continue;
        for (let i = span.start + 2; i < span.end; i += 3) model.positions[i] += delta;
        span.offset = next;
        changed = true;
      }
      if (changed)
        (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      const [trunks, leaves, cones] = chunk.group.children.slice(1) as THREE.InstancedMesh[];
      const dummy = new THREE.Object3D();
      let li = 0,
        ci = 0;
      model.trees.forEach((t, i) => {
        const z = this.map.queryTerrainElevation([t.lon, t.lat]);
        if (z !== null && Number.isFinite(z) && (z !== 0 || Math.abs(t.z) <= 5 || terrainComplete))
          t.z = z;
        dummy.position.set(t.x, t.y, t.z + t.height * 0.22 - 0.3);
        dummy.scale.set(1, 1, t.height * 0.44);
        dummy.updateMatrix();
        trunks.setMatrixAt(i, dummy.matrix);
        dummy.position.set(t.x, t.y, t.z + t.height * 0.65 - 0.3);
        dummy.scale.set(t.radius, t.radius, t.height * (t.conifer ? 0.75 : 0.38));
        dummy.updateMatrix();
        (t.conifer ? cones : leaves).setMatrixAt(t.conifer ? ci++ : li++, dummy.matrix);
      });
      for (const m of [trunks, leaves, cones]) m.instanceMatrix.needsUpdate = true;
      this.map.triggerRepaint();
    }
  }
  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.visible || !this.chunks.size) return;
    const origin = MercatorCoordinate.fromLngLat(this.origin),
      scale = origin.meterInMercatorCoordinateUnits();
    const matrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as number[]);
    const transform = new THREE.Matrix4()
      .makeTranslation(origin.x, origin.y, 0)
      .scale(new THREE.Vector3(scale, -scale, scale));
    this.camera.projectionMatrix = matrix.multiply(transform);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.renderer.resetState();
  }
  onRemove() {
    this.map.off('sourcedata', this.terrainChanged);
    clearTimeout(this.terrainTimer);
    this.clear();
    this.renderer.dispose();
  }
}
