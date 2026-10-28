// Mapa 3D de la red AirWard: los nodos, el broker y los mensajes MQTT viajando entre ellos.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const reducirMovimiento = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Ubicación de cada equipo sobre la plataforma y altura desde donde salen los enlaces.
// Es una disposición ilustrativa, no la posición real de los equipos.
const EQUIPOS = {
  broker:    { pos: [0, 0, 0],       alto: 1.55, radio: 1.2,  nombre: "Broker MQTT", giro: 0 },
  principal: { pos: [-2.6, 0, 2.8],  alto: 1.15, radio: 1.05, nombre: "Principal",   giro: 0.45 },
  mhz19:     { pos: [3.8, 0, 0.8],   alto: 0.75, radio: 0.9,  nombre: "MH-Z19",      giro: -0.6 },
  mq7:       { pos: [0.6, 0, -4.0],  alto: 0.75, radio: 0.9,  nombre: "MQ-7",        giro: -0.2 },
  web:       { pos: [-4.2, 0, -1.2], alto: 1.25, radio: 0.95, nombre: "Esta página", giro: 0.9 },
};
const CONECTADOS_AL_BROKER = ["principal", "mhz19", "mq7", "web"];

const POS_CAMARA = new THREE.Vector3(7.6, 6.2, 9.3);
// En pantallas verticales (celular) se mira más desde arriba para llenar el alto.
const POS_CAMARA_VERTICAL = new THREE.Vector3(5.2, 12.5, 6.4);
const OBJETIVO = new THREE.Vector3(0, 0.6, 0);

function leerColor(variable) {
  const valor = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return new THREE.Color(valor || "#888888");
}

function suavizar(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function texturaBrillo() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const degradado = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  degradado.addColorStop(0, "rgba(255,255,255,1)");
  degradado.addColorStop(0.3, "rgba(255,255,255,0.6)");
  degradado.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = degradado;
  g.fillRect(0, 0, 64, 64);
  const textura = new THREE.CanvasTexture(c);
  textura.colorSpace = THREE.SRGBColorSpace;
  return textura;
}

export function crearMapa(contenedor) {
  // --- Escena, cámara y renderizadores ---
  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camara.position.copy(POS_CAMARA);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.classList.add("mapa-lienzo");
  contenedor.appendChild(renderer.domElement);

  const etiquetas = new CSS2DRenderer();
  etiquetas.domElement.classList.add("mapa-etiquetas");
  contenedor.appendChild(etiquetas.domElement);

  const controles = new OrbitControls(camara, renderer.domElement);
  controles.target.copy(OBJETIVO);
  controles.enableDamping = true;
  controles.enablePan = false;
  controles.minDistance = 7;
  controles.maxDistance = 24;
  controles.maxPolarAngle = Math.PI * 0.46; // no mirar desde abajo de la plataforma
  controles.autoRotate = !reducirMovimiento;
  controles.autoRotateSpeed = 0.5;
  controles.update();

  // --- Luces ---
  escena.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
  const sol = new THREE.DirectionalLight(0xffffff, 1.8);
  sol.position.set(5, 10, 6);
  sol.castShadow = true;
  sol.shadow.mapSize.set(1024, 1024);
  Object.assign(sol.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 30 });
  sol.shadow.bias = -0.0005;
  escena.add(sol);

  // --- Materiales que siguen el tema claro/oscuro ---
  const mat = {
    plataforma: new THREE.MeshStandardMaterial({ roughness: 0.95 }),
    aro: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 }),
    dispositivo: new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }),
    detalle: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 }),
    placa: new THREE.MeshStandardMaterial({ color: 0x14532d, roughness: 0.6 }),
    dorado: new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.8 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xb8c2c8, roughness: 0.3, metalness: 0.9 }),
  };
  let colores = {};

  function caja(w, h, d, material, r = 0.08) {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, r), material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // --- Plataforma ---
  const plataforma = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 6.7, 0.3, 96), mat.plataforma);
  plataforma.position.y = -0.15;
  plataforma.receiveShadow = true;
  escena.add(plataforma);

  const aro = new THREE.Mesh(new THREE.TorusGeometry(6.55, 0.03, 8, 160), mat.aro);
  aro.rotation.x = Math.PI / 2;
  escena.add(aro);

  let grilla = null;
  function crearGrilla() {
    if (grilla) {
      escena.remove(grilla);
      grilla.geometry.dispose();
      grilla.material.dispose();
    }
    grilla = new THREE.PolarGridHelper(6.3, 12, 6, 96, colores.grilla, colores.grilla);
    grilla.material.transparent = true;
    grilla.material.opacity = 0.55;
    grilla.position.y = 0.004;
    escena.add(grilla);
  }

  // --- Equipos ---
  function crearBroker() {
    const g = new THREE.Group();
    const torre = caja(1.1, 1.7, 1.2, mat.dispositivo, 0.1);
    torre.position.y = 0.85;
    g.add(torre);

    for (let i = 0; i < 5; i++) {
      const ranura = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.025, 0.02), mat.detalle);
      ranura.position.set(0, 0.3 + i * 0.09, 0.605);
      g.add(ranura);
    }

    const leds = [];
    for (let i = 0; i < 3; i++) {
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(0.62, 0.07, 0.02),
        new THREE.MeshBasicMaterial({ toneMapped: false }),
      );
      led.position.set(0, 1.4 - i * 0.17, 0.605);
      led.userData.brillo = 0;
      g.add(led);
      leds.push(led);
    }

    // Logo de Docker estilizado: una ballena de cubitos
    const cubo = new THREE.BoxGeometry(0.09, 0.09, 0.02);
    const azul = new THREE.MeshBasicMaterial({ color: 0x2496ed });
    [[-0.1, 0], [0, 0], [0.1, 0], [0, 0.1]].forEach(([x, y]) => {
      const c = new THREE.Mesh(cubo, azul);
      c.position.set(x, 0.85 + y, 0.605);
      g.add(c);
    });
    return { grupo: g, leds };
  }

  function crearPrincipal() {
    const g = new THREE.Group();
    const base = caja(1.6, 0.24, 1.0, mat.dispositivo, 0.06);
    base.position.y = 0.12;
    g.add(base);

    const soporte = new THREE.Group();
    soporte.position.set(0, 0.24, -0.2);
    soporte.rotation.x = -0.22;
    const marco = caja(1.46, 1.06, 0.1, mat.detalle, 0.04);
    marco.position.y = 0.53;
    soporte.add(marco);

    // Pantalla ILI9341 simulada: se dibuja en un canvas con el mismo formato que el firmware
    const lienzo = document.createElement("canvas");
    lienzo.width = 320;
    lienzo.height = 240;
    const textura = new THREE.CanvasTexture(lienzo);
    textura.colorSpace = THREE.SRGBColorSpace;
    textura.anisotropy = 4;
    const pantalla = new THREE.Mesh(
      new THREE.PlaneGeometry(1.33, 1.0),
      new THREE.MeshBasicMaterial({ map: textura, toneMapped: false }),
    );
    pantalla.position.set(0, 0.53, 0.052);
    soporte.add(pantalla);
    g.add(soporte);

    const aht = caja(0.22, 0.06, 0.22, mat.placa, 0.02);
    aht.position.set(0.55, 0.27, 0.28);
    g.add(aht);
    return { grupo: g, lienzo, textura };
  }

  function crearSensor(tipo) {
    const g = new THREE.Group();
    const placa = caja(1.0, 0.1, 0.7, mat.placa, 0.03);
    placa.position.y = 0.05;
    g.add(placa);

    const esp = caja(0.42, 0.08, 0.32, mat.detalle, 0.02);
    esp.position.set(-0.2, 0.14, 0.05);
    g.add(esp);

    if (tipo === "mhz19") {
      const sensor = caja(0.42, 0.22, 0.34, mat.dorado, 0.03);
      sensor.position.set(0.24, 0.21, 0);
      g.add(sensor);
    } else {
      const sensor = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.26, 24), mat.metal);
      sensor.position.set(0.24, 0.23, 0);
      sensor.castShadow = true;
      g.add(sensor);
      const tapa = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 24), mat.detalle);
      tapa.position.set(0.24, 0.37, 0);
      g.add(tapa);
    }

    const antena = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 8), mat.detalle);
    antena.position.set(-0.4, 0.35, -0.25);
    g.add(antena);
    const punta = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), mat.detalle);
    punta.position.set(-0.4, 0.61, -0.25);
    g.add(punta);

    g.scale.setScalar(1.25);
    return { grupo: g };
  }

  function crearWeb() {
    const g = new THREE.Group();
    const pie = caja(0.6, 0.05, 0.4, mat.detalle, 0.02);
    pie.position.y = 0.025;
    g.add(pie);
    const cuello = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.45, 12), mat.detalle);
    cuello.position.y = 0.27;
    g.add(cuello);
    const monitor = caja(1.4, 0.85, 0.07, mat.detalle, 0.03);
    monitor.position.y = 0.88;
    g.add(monitor);

    // Miniatura de este mismo tablero
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 150;
    const x = c.getContext("2d");
    x.fillStyle = "#0b1820";
    x.fillRect(0, 0, 256, 150);
    x.fillStyle = "#4cc9f0";
    x.font = "bold 16px sans-serif";
    x.fillText("AirWard", 12, 22);
    ["#ff9f43", "#4cc9f0", "#3ddc84", "#b388ff"].forEach((color, i) => {
      const px = 12 + i * 60;
      x.fillStyle = "#13242e";
      x.fillRect(px, 34, 52, 50);
      x.fillStyle = color;
      x.fillRect(px, 34, 3, 50);
      x.fillRect(px + 10, 50, 30, 10);
    });
    x.fillStyle = "#13242e";
    x.fillRect(12, 94, 232, 46);
    const textura = new THREE.CanvasTexture(c);
    textura.colorSpace = THREE.SRGBColorSpace;
    const pantalla = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 0.76),
      new THREE.MeshBasicMaterial({ map: textura, toneMapped: false }),
    );
    pantalla.position.set(0, 0.88, 0.037);
    g.add(pantalla);
    return { grupo: g };
  }

  const constructores = {
    broker: crearBroker,
    principal: crearPrincipal,
    mhz19: () => crearSensor("mhz19"),
    mq7: () => crearSensor("mq7"),
    web: crearWeb,
  };

  const nodos = {};
  for (const [id, e] of Object.entries(EQUIPOS)) {
    const partes = constructores[id]();
    partes.grupo.position.set(...e.pos);
    partes.grupo.rotation.y = e.giro;
    escena.add(partes.grupo);

    // Halo en el piso: el color indica el estado
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(e.radio, e.radio + 0.12, 64),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(e.pos[0], 0.012, e.pos[2]);
    escena.add(halo);

    const disco = new THREE.Mesh(
      new THREE.CircleGeometry(e.radio, 64),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.08, depthWrite: false }),
    );
    disco.rotation.x = -Math.PI / 2;
    disco.position.set(e.pos[0], 0.008, e.pos[2]);
    escena.add(disco);

    // Etiqueta HTML que sigue al equipo
    const div = document.createElement("div");
    div.className = "et";
    div.innerHTML = '<span class="et-cab"><span class="et-punto"></span><span class="et-nombre"></span></span><span class="et-valor"></span>';
    div.querySelector(".et-nombre").textContent = e.nombre;
    const etiqueta = new CSS2DObject(div);
    etiqueta.position.set(e.pos[0], e.alto + 0.55, e.pos[2]);
    etiqueta.center.set(0.5, 1);
    escena.add(etiqueta);

    nodos[id] = { ...partes, halo, disco, div, estado: null, pulso: 0, fase: Math.random() * Math.PI * 2 };
  }

  // --- Enlaces al broker (curvas elevadas) ---
  function anclaje(id) {
    const e = EQUIPOS[id];
    return new THREE.Vector3(e.pos[0], e.alto, e.pos[2]);
  }

  const enlaces = {};
  for (const id of CONECTADOS_AL_BROKER) {
    const a = anclaje(id);
    const b = anclaje("broker");
    const medio = a.clone().lerp(b, 0.5);
    medio.y += 1.3;
    const curva = new THREE.QuadraticBezierCurve3(a, medio, b);
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false });
    escena.add(new THREE.Mesh(new THREE.TubeGeometry(curva, 64, 0.018, 6, false), material));
    enlaces[id] = { curva, material };
  }

  // --- Paquetes (mensajes MQTT viajando) ---
  const brillo = texturaBrillo();
  const geoPaquete = new THREE.SphereGeometry(0.07, 16, 12);
  const paquetes = [];

  function lanzar(id, haciaBroker, color, alLlegar) {
    if (reducirMovimiento || paquetes.length > 60) {
      alLlegar?.();
      return;
    }
    const nucleo = new THREE.Mesh(geoPaquete, new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    const aura = new THREE.Sprite(new THREE.SpriteMaterial({
      map: brillo, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    aura.scale.setScalar(0.6);
    nucleo.add(aura);
    nucleo.position.copy(enlaces[id].curva.getPoint(haciaBroker ? 0 : 1));
    escena.add(nucleo);
    paquetes.push({ nucleo, curva: enlaces[id].curva, haciaBroker, t: 0, duracion: 0.9, alLlegar });
  }

  function pulsar(id) {
    nodos[id].pulso = 1;
  }

  function destellarLeds() {
    nodos.broker.leds.forEach((led, i) => {
      setTimeout(() => { led.userData.brillo = 1; }, i * 70);
    });
  }

  // --- Pantalla del principal ---
  let ultimaPantalla = "";
  function dibujarPantalla(d) {
    const firma = JSON.stringify(d);
    if (firma === ultimaPantalla) return;
    ultimaPantalla = firma;

    const g = nodos.principal.lienzo.getContext("2d");
    g.fillStyle = "#000";
    g.fillRect(0, 0, 320, 240);
    g.fillStyle = "#00ffff";
    g.font = "bold 30px monospace";
    g.fillText("AirWard", 10, 34);
    g.fillStyle = "#555";
    g.fillRect(0, 44, 320, 2);

    const filas = [
      ["Temperatura", d.temp],
      ["Humedad", d.hum],
      ["CO2", d.co2, d.colorCo2],
      ["CO (MQ7)", d.co],
    ];
    filas.forEach(([nombre, valor, color], i) => {
      const y = 86 + i * 42;
      g.font = "19px monospace";
      g.fillStyle = "#c6c6c6";
      g.fillText(nombre, 10, y);
      g.font = "bold 26px monospace";
      g.fillStyle = color || (valor === "---" ? "#7b7b7b" : "#ffffff");
      g.fillText(valor, 168, y);
    });
    g.font = "12px monospace";
    g.fillStyle = "#7b7b7b";
    g.fillText(d.estado, 10, 230);
    nodos.principal.textura.needsUpdate = true;
  }

  // --- Colores del tema ---
  function colorEstado(estado) {
    return estado === "online" ? colores.online : estado === "offline" ? colores.offline : colores.neutro;
  }

  function aplicarEstado(id) {
    const n = nodos[id];
    const color = colorEstado(n.estado);
    n.halo.material.color.copy(color);
    n.disco.material.color.copy(color);
    if (n.estado) n.div.dataset.estado = n.estado;
    else delete n.div.dataset.estado;

    const enlace = enlaces[id];
    if (enlace) {
      const activo = n.estado === "online" && nodos.broker.estado === "online";
      enlace.material.color.copy(activo ? colores.acento : colores.neutro);
      enlace.material.opacity = activo ? 0.5 : 0.18;
    }
  }

  function aplicarTema() {
    colores = {
      plataforma: leerColor("--mapa-plataforma"),
      grilla: leerColor("--mapa-grilla"),
      dispositivo: leerColor("--mapa-dispositivo"),
      detalle: leerColor("--mapa-detalle"),
      acento: leerColor("--acento"),
      online: leerColor("--bueno"),
      offline: leerColor("--alto"),
      neutro: leerColor("--neutro"),
      ledApagado: leerColor("--mapa-detalle"),
      paquete: {
        principal: leerColor("--c-temp"),
        mhz19: leerColor("--c-co2"),
        mq7: leerColor("--c-co"),
      },
    };
    mat.plataforma.color.copy(colores.plataforma);
    mat.aro.color.copy(colores.acento);
    mat.dispositivo.color.copy(colores.dispositivo);
    mat.detalle.color.copy(colores.detalle);
    crearGrilla();
    Object.keys(nodos).forEach(aplicarEstado);
    renderizar();
  }

  // --- Bucle de animación ---
  const reloj = new THREE.Clock();
  let tiempo = 0;

  function animar() {
    const dt = Math.min(reloj.getDelta(), 0.1);
    tiempo += dt;

    for (let i = paquetes.length - 1; i >= 0; i--) {
      const p = paquetes[i];
      p.t += dt / p.duracion;
      if (p.t >= 1) {
        escena.remove(p.nucleo);
        p.nucleo.material.dispose();
        p.nucleo.children[0].material.dispose();
        paquetes.splice(i, 1);
        p.alLlegar?.();
        continue;
      }
      const t = suavizar(p.t);
      p.nucleo.position.copy(p.curva.getPoint(p.haciaBroker ? t : 1 - t));
    }

    for (const n of Object.values(nodos)) {
      n.pulso = Math.max(0, n.pulso - dt * 1.8);
      const respiro = n.estado === "online" && !reducirMovimiento ? Math.sin(tiempo * 2 + n.fase) * 0.12 : 0;
      n.halo.scale.setScalar(1 + n.pulso * 0.3);
      n.halo.material.opacity = 0.5 + respiro + n.pulso * 0.4;
      n.disco.material.opacity = 0.07 + n.pulso * 0.2;
    }

    const brokerActivo = nodos.broker.estado === "online";
    for (const led of nodos.broker.leds) {
      led.userData.brillo = Math.max(0, led.userData.brillo - dt * 2.5);
      const base = brokerActivo ? 0.15 : 0;
      led.material.color.copy(colores.ledApagado).lerp(colores.online, Math.min(1, base + led.userData.brillo));
    }

    controles.update();
    renderizar();
  }

  function renderizar() {
    renderer.render(escena, camara);
    etiquetas.render(escena, camara);
  }

  // Solo anima cuando el mapa está a la vista y la pestaña está abierta.
  let enPantalla = true;
  function actualizarBucle() {
    const activo = enPantalla && !document.hidden;
    if (activo) reloj.getDelta(); // descarta el tiempo que estuvo pausado
    renderer.setAnimationLoop(activo ? animar : null);
  }
  new IntersectionObserver(([entrada]) => {
    enPantalla = entrada.isIntersecting;
    actualizarBucle();
  }).observe(contenedor);
  document.addEventListener("visibilitychange", actualizarBucle);

  function esVertical() {
    return camara.aspect < 0.9;
  }

  function centrar() {
    camara.position.copy(esVertical() ? POS_CAMARA_VERTICAL : POS_CAMARA);
    controles.target.copy(OBJETIVO);
    controles.update();
    renderizar();
  }

  let ultimaOrientacion = null;
  function ajustarTamano() {
    const w = contenedor.clientWidth;
    const h = contenedor.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    etiquetas.setSize(w, h);
    camara.aspect = w / h;
    // En pantallas angostas se abre el ángulo para que entren todos los equipos.
    camara.fov = esVertical() ? 60 : camara.aspect < 1.25 ? 50 : 38;
    camara.updateProjectionMatrix();
    // Al girar el celular (o en la primera carga) se vuelve a la vista que corresponde.
    if (esVertical() !== ultimaOrientacion) {
      ultimaOrientacion = esVertical();
      centrar();
    }
    renderizar();
  }
  new ResizeObserver(ajustarTamano).observe(contenedor);

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", aplicarTema);
  aplicarTema();
  ajustarTamano();
  actualizarBucle();

  // --- API para app.js ---
  return {
    /** Un nodo publicó: paquete nodo → broker, y del broker a cada suscriptor. */
    mensaje(origen, destinos) {
      const color = colores.paquete[origen] || colores.acento;
      pulsar(origen);
      lanzar(origen, true, color, () => {
        pulsar("broker");
        destellarLeds();
        for (const d of destinos) {
          if (nodos[d].estado !== "offline") lanzar(d, false, color, () => pulsar(d));
        }
      });
    },
    estado(id, estado) {
      if (!nodos[id]) return;
      nodos[id].estado = estado;
      aplicarEstado(id);
      if (id === "broker") CONECTADOS_AL_BROKER.forEach(aplicarEstado);
    },
    etiqueta(id, texto, nivel = "neutro") {
      const div = nodos[id]?.div;
      if (!div) return;
      div.querySelector(".et-valor").textContent = texto;
      div.dataset.nivel = nivel;
    },
    pantalla: dibujarPantalla,
    rotando: () => controles.autoRotate,
    rotacion(activar) {
      controles.autoRotate = activar;
    },
    centrar,
  };
}
