// AirWard: escucha el broker MQTT por WebSocket y muestra las lecturas en vivo.

// El broker está en la misma PC que sirve la página (puerto 9001, WebSockets).
// Para apuntar a otro: http://...:8080/?broker=ws://IP:9001  ·  Para arrancar en demo: ?demo=1
const params = new URLSearchParams(location.search);
const BROKER_URL = params.get("broker") || `ws://${location.hostname || "localhost"}:9001`;

const TIMEOUT_DATO_MS = 10000; // igual que la pantalla del principal: sin datos por 10 s -> "---"
const MAX_PUNTOS = 150;        // 5 minutos a una lectura cada 2 s
const INTERVALO_DEMO_MS = 2000;

// ---------------------------------------------------------------
// Niveles (orientativos)
// ---------------------------------------------------------------
// Los mismos umbrales de CO2 que usa la pantalla del principal.
function nivelCO2(ppm) {
  if (ppm <= 0) return { clase: "neutro", texto: "Sin lectura", detalle: "El MH-Z19 todavía no da una lectura válida (¿precalentando?)." };
  if (ppm >= 1200) return { clase: "alto", texto: "Alto", detalle: "Conviene ventilar el ambiente." };
  if (ppm >= 800) return { clase: "medio", texto: "Moderado", detalle: "Ventilar pronto." };
  return { clase: "bueno", texto: "Bueno", detalle: "Niveles normales para un interior." };
}

function nivelTemp(c) {
  if (c < 18) return { clase: "medio", texto: "Fresco" };
  if (c > 27) return { clase: "medio", texto: "Caluroso" };
  return { clase: "bueno", texto: "Confortable" };
}

function nivelHumedad(h) {
  if (h < 30) return { clase: "medio", texto: "Seco" };
  if (h > 65) return { clase: "medio", texto: "Húmedo" };
  return { clase: "bueno", texto: "Confortable" };
}

// El MQ-7 manda voltaje crudo: sin calibrar no se puede decir si es mucho o poco.
const nivelCO = () => ({ clase: "neutro", texto: "Sin calibrar" });

const SENSORES = {
  temp:    { topic: "airward/aht10", campo: "temp",    decimales: 1, unidad: "°C",  nivel: nivelTemp },
  humedad: { topic: "airward/aht10", campo: "humedad", decimales: 0, unidad: "%",   nivel: nivelHumedad },
  co2:     { topic: "airward/mhz19", campo: "co2_ppm", decimales: 0, unidad: "ppm", nivel: nivelCO2 },
  co:      { topic: "airward/mq7",   campo: "voltaje", decimales: 2, unidad: "V",   nivel: nivelCO },
};

// Qué nodo publica cada topic, y a quién se lo reenvía el broker
// (el principal está suscripto a airward/# para mostrarlo en su pantalla).
const ORIGEN_TOPIC = { "airward/aht10": "principal", "airward/mhz19": "mhz19", "airward/mq7": "mq7" };
const DESTINOS = { principal: ["web"], mhz19: ["principal", "web"], mq7: ["principal", "web"] };

// estado: lo que se muestra · estadoReal: lo último que dijo el broker (se recupera al salir del demo)
const NODOS = {
  principal: { estado: null, estadoReal: null },
  mhz19:     { estado: null, estadoReal: null },
  mq7:       { estado: null, estadoReal: null },
};

for (const [id, s] of Object.entries(SENSORES)) {
  const tarjeta = document.querySelector(`[data-sensor="${id}"]`);
  s.el = {
    tarjeta,
    valor: tarjeta.querySelector(".valor"),
    chip: tarjeta.querySelector(".chip"),
    linea: tarjeta.querySelector(".linea"),
    area: tarjeta.querySelector(".area"),
    rango: tarjeta.querySelector(".rango"),
    escala: tarjeta.querySelector(".escala"),
  };
  reiniciarSensor(s);
}

const el = {
  conexion: document.getElementById("conexion"),
  conexionTexto: document.getElementById("conexion-texto"),
  resumen: document.getElementById("resumen"),
  resumenEstado: document.getElementById("resumen-estado"),
  resumenDetalle: document.getElementById("resumen-detalle"),
  resumenNodos: document.getElementById("resumen-nodos"),
  resumenUltima: document.getElementById("resumen-ultima"),
  botonDemo: document.getElementById("boton-demo"),
  avisoDemo: document.getElementById("aviso-demo"),
  botonRotar: document.getElementById("boton-rotar"),
  botonCentrar: document.getElementById("boton-centrar"),
  mapaCargando: document.getElementById("mapa-cargando"),
};
document.getElementById("pie-broker").textContent = BROKER_URL;

let conectado = false;
let ultimaLectura = 0;
let demo = null;   // id del setInterval mientras el modo demo está activo
let mapa = null;   // se carga aparte: si Three.js no baja, el resto de la página funciona igual

// ---------------------------------------------------------------
// Conexión al broker
// ---------------------------------------------------------------
function estadoConexion(estado, texto) {
  el.conexion.dataset.estado = estado;
  el.conexionTexto.textContent = texto;
  el.conexion.title = BROKER_URL;
  mapa?.estado("broker", conectado ? "online" : "offline");
  mapa?.estado("web", conectado || demo ? "online" : "offline");
}

if (typeof mqtt === "undefined") {
  estadoConexion("error", "Sin librería MQTT");
} else {
  const cliente = mqtt.connect(BROKER_URL, {
    clientId: "airward-web-" + Math.random().toString(16).slice(2, 10),
    reconnectPeriod: 2000,
    connectTimeout: 5000,
  });

  cliente.on("connect", () => {
    conectado = true;
    estadoConexion("ok", "Conectado");
    cliente.subscribe("airward/#");
  });
  cliente.on("reconnect", () => estadoConexion("conectando", "Reconectando…"));
  cliente.on("offline", () => {
    conectado = false;
    estadoConexion("error", "Sin conexión");
  });
  cliente.on("message", (topic, payload) => recibir(topic, payload.toString(), "mqtt"));
}

// ---------------------------------------------------------------
// Mensajes (reales o del modo demo)
// ---------------------------------------------------------------
function recibir(topic, texto, origen) {
  // airward/<nodo>/status: "online" / "offline" (retenido, con last will). Vacío = se borró.
  if (topic.endsWith("/status")) {
    const nodo = topic.split("/")[1];
    if (!NODOS[nodo]) return;
    if (origen === "mqtt") NODOS[nodo].estadoReal = texto || null;
    if (demo && origen === "mqtt") return;
    actualizarNodo(nodo, texto || null);
    return;
  }

  // Durante el demo, los datos reales se ignoran para no mezclar.
  if (demo && origen === "mqtt") return;

  const nodo = ORIGEN_TOPIC[topic];
  if (!nodo) return;

  let datos;
  try {
    datos = JSON.parse(texto);
  } catch {
    return;
  }

  const ahora = Date.now();
  let hubo = false;
  for (const s of Object.values(SENSORES)) {
    if (s.topic !== topic || typeof datos[s.campo] !== "number") continue;
    s.valor = datos[s.campo];
    s.ultimo = ahora;
    s.min = s.min === null ? s.valor : Math.min(s.min, s.valor);
    s.max = s.max === null ? s.valor : Math.max(s.max, s.valor);
    s.historial.push(s.valor);
    if (s.historial.length > MAX_PUNTOS) s.historial.shift();
    dibujarGrafico(s);
    hubo = true;
  }
  if (!hubo) return;

  ultimaLectura = ahora;
  mapa?.mensaje(nodo, DESTINOS[nodo]);
  refrescar();
}

function actualizarNodo(id, estado) {
  NODOS[id].estado = estado;
  const li = document.querySelector(`[data-nodo="${id}"]`);
  if (estado) li.dataset.estado = estado;
  else delete li.dataset.estado;
  li.querySelector(".nodo-estado").textContent =
    estado === "online" ? "En línea" : estado === "offline" ? "Desconectado" : "Sin datos";
  mapa?.estado(id, estado);
  refrescar();
}

// ---------------------------------------------------------------
// Modo demo: genera lecturas en este navegador (no publica nada en el broker)
// ---------------------------------------------------------------
const simulado = { temp: 23.4, humedad: 48, co: 0.5, fase: 0 };

function limitar(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function pasoDemo() {
  simulado.fase += 0.05;
  simulado.temp = limitar(simulado.temp + (Math.random() - 0.5) * 0.3, 19, 28);
  simulado.humedad = limitar(simulado.humedad + (Math.random() - 0.5) * 1.2, 35, 70);
  simulado.co = limitar(simulado.co + (Math.random() - 0.5) * 0.05, 0.3, 1.2);
  // El CO2 sube y baja en unos 4 minutos para recorrer los tres niveles.
  const co2 = Math.round(900 + 450 * Math.sin(simulado.fase) + (Math.random() - 0.5) * 40);

  const publicar = (topic, datos, demora) =>
    setTimeout(() => demo && recibir(topic, JSON.stringify(datos), "demo"), demora);
  publicar("airward/aht10", { id_nodo: "aht10", temp: +simulado.temp.toFixed(1), humedad: +simulado.humedad.toFixed(1) }, 0);
  publicar("airward/mhz19", { id_nodo: "mhz19", co2_ppm: co2 }, 650);
  publicar("airward/mq7", { id_nodo: "mq7", voltaje: +simulado.co.toFixed(2) }, 1300);
}

function alternarDemo(activar) {
  if (activar === Boolean(demo)) return;

  for (const s of Object.values(SENSORES)) reiniciarSensor(s);
  ultimaLectura = 0;

  if (activar) {
    demo = setInterval(pasoDemo, INTERVALO_DEMO_MS);
    pasoDemo();
    for (const id of Object.keys(NODOS)) actualizarNodo(id, "online");
  } else {
    clearInterval(demo);
    demo = null;
    for (const [id, n] of Object.entries(NODOS)) actualizarNodo(id, n.estadoReal);
  }

  el.botonDemo.setAttribute("aria-pressed", String(activar));
  el.avisoDemo.hidden = !activar;
  mapa?.estado("web", conectado || demo ? "online" : "offline");
  refrescar();
}

el.botonDemo.addEventListener("click", () => alternarDemo(!demo));

// ---------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------
function formatear(valor, decimales) {
  return valor.toLocaleString("es-AR", {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });
}

function tiempoDesde(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

function esVigente(s, ahora = Date.now()) {
  return s.ultimo !== 0 && ahora - s.ultimo < TIMEOUT_DATO_MS;
}

function reiniciarSensor(s) {
  s.valor = null;
  s.ultimo = 0;
  s.min = null;
  s.max = null;
  s.historial = [];
  s.el.linea.setAttribute("points", "");
  s.el.area.setAttribute("d", "");
}

function refrescar() {
  const ahora = Date.now();
  for (const s of Object.values(SENSORES)) pintarSensor(s, ahora);
  pintarResumen(ahora);
  pintarMapa(ahora);
}

function pintarSensor(s, ahora) {
  const { tarjeta, valor, chip, rango, escala } = s.el;

  if (!esVigente(s, ahora)) {
    valor.textContent = "---";
    tarjeta.dataset.nivel = "neutro";
    chip.textContent = s.ultimo === 0 ? "Esperando datos" : `Sin datos hace ${tiempoDesde(ahora - s.ultimo)}`;
    if (s.ultimo === 0) rango.textContent = "";
    if (escala) delete escala.dataset.activa;
    return;
  }

  const nivel = s.nivel(s.valor);
  valor.textContent = formatear(s.valor, s.decimales);
  tarjeta.dataset.nivel = nivel.clase;
  chip.textContent = nivel.texto;
  rango.textContent = `mín ${formatear(s.min, s.decimales)} · máx ${formatear(s.max, s.decimales)}`;

  if (escala) {
    // Escala de 400 a 2000 ppm
    const pos = limitar((s.valor - 400) / 1600, 0, 1) * 100;
    escala.style.setProperty("--pos", `${pos}%`);
    escala.dataset.activa = "";
  }
}

const TEXTO_RESUMEN = { bueno: "Buena", medio: "Regular", alto: "Mala", neutro: "Sin lectura" };

function pintarResumen(ahora) {
  const co2 = SENSORES.co2;
  if (esVigente(co2, ahora)) {
    const n = nivelCO2(co2.valor);
    el.resumen.dataset.nivel = n.clase;
    el.resumenEstado.textContent = TEXTO_RESUMEN[n.clase];
    el.resumenDetalle.textContent = n.clase === "neutro"
      ? n.detalle
      : `${formatear(co2.valor, 0)} ppm de CO₂. ${n.detalle}`;
  } else {
    el.resumen.dataset.nivel = "neutro";
    el.resumenEstado.textContent = "Sin datos";
    el.resumenDetalle.textContent = "Esperando lecturas de CO₂ del MH-Z19.";
  }

  const enLinea = Object.values(NODOS).filter((n) => n.estado === "online").length;
  el.resumenNodos.textContent = `${enLinea} de ${Object.keys(NODOS).length}`;
  el.resumenUltima.textContent = ultimaLectura ? `hace ${tiempoDesde(ahora - ultimaLectura)}` : "—";
}

function dibujarGrafico(s) {
  const h = s.historial;
  if (h.length < 2) return;

  let min = Math.min(...h);
  let max = Math.max(...h);
  if (max - min < 1e-6) { min -= 1; max += 1; } // valor constante: línea al medio
  const margen = (max - min) * 0.15;
  min -= margen;
  max += margen;

  const puntos = h.map((v, i) => {
    const x = (i / (h.length - 1)) * 100;
    const y = 32 - ((v - min) / (max - min)) * 32;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  s.el.linea.setAttribute("points", puntos.join(" "));
  s.el.area.setAttribute("d", `M0,32 L${puntos.join(" L")} L100,32 Z`);
}

// ---------------------------------------------------------------
// Mapa 3D
// ---------------------------------------------------------------
const COLOR_TFT = { bueno: "#00ff00", medio: "#ffff00", alto: "#ff0000", neutro: "#7b7b7b" };

function pintarMapa(ahora) {
  if (!mapa) return;
  const { temp, humedad, co2, co } = SENSORES;
  const texto = (s) => (esVigente(s, ahora) ? `${formatear(s.valor, s.decimales)} ${s.unidad}` : "---");

  const hayAht = esVigente(temp, ahora) || esVigente(humedad, ahora);
  mapa.etiqueta("principal", hayAht ? `${texto(temp)} · ${texto(humedad)}` : "sin datos");
  mapa.etiqueta("mhz19", esVigente(co2, ahora) ? texto(co2) : "sin datos",
    esVigente(co2, ahora) ? nivelCO2(co2.valor).clase : "neutro");
  mapa.etiqueta("mq7", esVigente(co, ahora) ? texto(co) : "sin datos");
  mapa.etiqueta("broker", conectado ? "conectado" : "sin conexión");
  mapa.etiqueta("web", demo ? "datos simulados" : "en vivo");

  // La pantalla del principal, imitando el formato del firmware.
  const tft = (s, f) => (esVigente(s, ahora) ? f(s.valor) : "---");
  mapa.pantalla({
    temp: tft(temp, (v) => `${v.toFixed(1)} C`),
    hum: tft(humedad, (v) => `${v.toFixed(0)} %`),
    co2: tft(co2, (v) => `${v.toFixed(0)} ppm`),
    colorCo2: esVigente(co2, ahora) ? COLOR_TFT[nivelCO2(co2.valor).clase] : null,
    co: tft(co, (v) => `${v.toFixed(2)} V`),
    estado: `WiFi:${NODOS.principal.estado === "online" ? "OK" : "--"}  MQTT:${NODOS.principal.estado === "online" ? "OK" : "--"}`,
  });
}

import("./mapa3d.js")
  .then(({ crearMapa }) => {
    mapa = crearMapa(document.getElementById("mapa"));
    el.mapaCargando.remove();

    for (const [id, n] of Object.entries(NODOS)) mapa.estado(id, n.estado);
    mapa.estado("broker", conectado ? "online" : "offline");
    mapa.estado("web", conectado || demo ? "online" : "offline");

    el.botonRotar.disabled = false;
    el.botonCentrar.disabled = false;
    el.botonRotar.setAttribute("aria-pressed", String(mapa.rotando()));
    el.botonRotar.addEventListener("click", () => {
      const activar = !mapa.rotando();
      mapa.rotacion(activar);
      el.botonRotar.setAttribute("aria-pressed", String(activar));
    });
    el.botonCentrar.addEventListener("click", () => mapa.centrar());
    refrescar();
  })
  .catch((error) => {
    console.error("No se pudo crear el mapa 3D:", error);
    el.mapaCargando.textContent = "No se pudo cargar el mapa 3D. Necesita internet para descargar Three.js y un navegador con WebGL.";
  });

// ---------------------------------------------------------------
if (params.get("demo") === "1") alternarDemo(true);

// Revisa cada segundo si algún dato quedó viejo.
setInterval(refrescar, 1000);
refrescar();
