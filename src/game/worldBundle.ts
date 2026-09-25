import * as THREE from 'three';
import { MAPS, type MapDef } from '../world/mapDefs';
import { CityWorld } from '../world/cityBuilder';
import { Environment } from '../world/environment';
import { SignalController } from '../traffic/signals';
import { AITraffic } from '../traffic/aiTraffic';
import { Pedestrians } from '../traffic/pedestrians';
import { Navigator } from '../missions/navigator';
import { MapRenderer } from '../ui/mapRenderer';
import type { QualityProfile } from '../core/settings';
import type { MarkerOpts } from '../missions/mission';
import { LAYER_DETAIL } from '../vehicle/cockpit';

/** Everything that belongs to one map: scene graph, simulation systems and map rendering. */
export class WorldBundle {
  readonly map: MapDef;
  readonly scene = new THREE.Scene();
  readonly world: CityWorld;
  readonly env: Environment;
  readonly signals: SignalController;
  readonly traffic: AITraffic;
  readonly peds: Pedestrians;
  readonly nav: Navigator;
  readonly mapRenderer: MapRenderer;
  readonly markers = new THREE.Group();
  private markerMap = new Map<string, THREE.Object3D>();
  private markerTime = 0;

  constructor(id: MapDef['id'], renderer: THREE.WebGLRenderer, q: QualityProfile) {
    this.map = MAPS[id];
    this.world = new CityWorld(this.map, q.anisotropy);
    this.scene.add(this.world.group);
    this.env = new Environment(this.scene, renderer);
    this.signals = new SignalController(this.world.net, this.world.signals);
    this.traffic = new AITraffic(this.world, this.signals, this.map.seed);
    this.scene.add(this.traffic.renderer.group);
    this.peds = new Pedestrians(this.world.net, this.signals, this.map.seed + 7);
    this.scene.add(this.peds.group);
    this.peds.detailLayer = LAYER_DETAIL;
    this.nav = new Navigator(this.world.net, this.scene);
    this.mapRenderer = new MapRenderer(this.world.net);
    this.scene.add(this.markers);
    this.applyQuality(q);
  }

  applyQuality(q: QualityProfile) {
    this.env.configure({ shadows: q.shadows, shadowMapSize: q.shadowMapSize, drawDistance: q.drawDistance, rainDrops: q.rainDrops });
  }

  setDensity(q: QualityProfile, traffic: number, peds: number) {
    this.traffic.target = Math.round(q.trafficCount * traffic * this.map.trafficScale);
    this.traffic.radius = Math.min(320, q.drawDistance * 0.6 + 60);
    this.peds.target = Math.round(q.pedestrianCount * peds);
  }

  reset() {
    this.traffic.clear();
    this.peds.clear();
    this.nav.clear();
    this.clearMarker();
  }

  marker(id: string, x: number, z: number, o: MarkerOpts = {}) {
    this.clearMarker(id);
    const color = new THREE.Color(o.color ?? 0x35a7ff);
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    if (o.kind === 'bay') {
      const w = o.w ?? 2.6;
      const l = o.l ?? 5.2;
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
      const t = 0.14;
      const parts: [number, number, number, number][] = [
        [0, l / 2, w, t],
        [0, -l / 2, w, t],
        [w / 2, 0, t, l],
        [-w / 2, 0, t, l],
      ];
      for (const [px, pz, sx, sz] of parts) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz).rotateX(-Math.PI / 2), mat);
        m.position.set(px, 0.05, pz);
        g.add(m);
      }
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }));
      fill.position.y = 0.04;
      g.add(fill);
      g.rotation.y = o.heading ?? 0;
    } else {
      const r = o.radius ?? 3;
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.25, r, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
      ring.position.y = 0.06;
      g.add(ring);
      if (o.kind !== 'ring') {
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(r * 0.55, r * 0.55, 40, 24, 1, true),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false })
        );
        beam.position.y = 20;
        g.add(beam);
      }
    }
    g.userData.color = '#' + color.getHexString();
    this.markers.add(g);
    this.markerMap.set(id, g);
  }

  clearMarker(id?: string) {
    if (id) {
      const m = this.markerMap.get(id);
      if (m) this.markers.remove(m);
      this.markerMap.delete(id);
      return;
    }
    for (const m of this.markerMap.values()) this.markers.remove(m);
    this.markerMap.clear();
  }

  markerList(): { x: number; z: number; color: string }[] {
    return [...this.markerMap.values()].map((m) => ({ x: m.position.x, z: m.position.z, color: m.userData.color as string }));
  }

  update(dt: number) {
    this.markerTime += dt;
    const pulse = 0.75 + Math.sin(this.markerTime * 4) * 0.2;
    for (const m of this.markerMap.values()) {
      m.traverse((o) => {
        const mm = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (mm && mm.opacity > 0.5) mm.opacity = pulse;
      });
    }
    this.nav.guide.update(dt);
  }
}
