#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <SPI.h>
#include <Adafruit_AHTX0.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

// --- WiFi y broker: se definen en include/secrets.h (copiar de secrets.h.example) ---
#include "secrets.h"

// --- MQTT (el puerto 1883 es el del broker Mosquitto en Docker) ---
const int MQTT_PORT = 1883;

// --- MQTT ---
const char* MQTT_CLIENT_ID = "airward-principal";
const char* MQTT_TOPIC_DATOS = "airward/aht10";
const char* MQTT_TOPIC_STATUS = "airward/principal/status";
const char* MQTT_TOPIC_SUSCRIBIR = "airward/#";

// --- Pantalla ILI9341 (SPI por hardware: SCK=GPIO18, MOSI=GPIO23) ---
#define TFT_CS  5
#define TFT_DC  17
#define TFT_RST 16
Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

// --- Sensor local (AHT10) ---
// AHT_SIMULADO = 1: valores fijos (el AHT10 soldado no responde). Poner 0 para usar el sensor real.
#define AHT_SIMULADO 1
const float SIM_TEMP = 22.0;
const float SIM_HUM = 30.0;

Adafruit_AHTX0 aht;
bool ahtOk = false;
float tempLocal = 0;
float humLocal = 0;

//LED_TEST
#define PIN_LED_TEST              13
#define CFG_LED_TEST              pinMode(PIN_LED_TEST, OUTPUT)
#define PRENDER_LED_TEST          digitalWrite(PIN_LED_TEST, HIGH)
#define APAGAR_LED_TEST           digitalWrite(PIN_LED_TEST, LOW)
#define AJUSTAR_LED_TEST(x)       digitalWrite(PIN_LED_TEST, x) 

void LedTest ()
  {
  static unsigned long millis_ant = 0;
  static bool blink = 0;
  static unsigned int tiempo_destello=1000;

  if (millis() - millis_ant < tiempo_destello) return;
  millis_ant = millis();
   
  tiempo_destello = (motor == MOTOR_ABRE || motor == MOTOR_CIERRA) ? 100 : 1000;
    
  blink = !blink;
  AJUSTAR_LED_TEST(blink);

  }

// --- Datos recibidos de los otros nodos ---
struct DatoRemoto {
  float valor = 0;
  unsigned long ultimo = 0;  // millis() del último mensaje recibido (0 = nunca)
};
DatoRemoto co2;
DatoRemoto mq7;
float co2Min = 0, co2Max = 0;   // desde que se encendió el principal

// --- Tiempos ---
const unsigned long INTERVALO_PUBLICACION = 2000;
const unsigned long INTERVALO_PANTALLA = 1000;
const unsigned long TIMEOUT_DATO_MS = 10000;   // sin mensajes por 10 s -> "---"
const unsigned long INTERVALO_REINTENTO = 5000;
const unsigned long INTERVALO_PAGINA = 10000;  // cambia de pantalla cada 10 s
const int REINICIAR_TFT_CADA = 3;              // cada N cambios de pantalla se reinicia el controlador (auto-recuperación)

WiFiClient espClient;
PubSubClient mqtt(espClient);
unsigned long ultimaPublicacion = 0;
unsigned long ultimaPantalla = 0;
unsigned long ultimoIntento = 0;
unsigned long ultimoCambioPagina = 0;

// ---------------------------------------------------------------
// MQTT: mensajes entrantes
// ---------------------------------------------------------------
void onMensaje(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<192> doc;
  // Los topics de status ("online"/"offline") no son JSON: se descartan acá.
  if (deserializeJson(doc, payload, length)) return;

  if (strcmp(topic, "airward/mhz19") == 0) {
    co2.valor = doc["co2_ppm"];
    co2.ultimo = millis();
    if (co2.valor > 0) {
      if (co2Min == 0 || co2.valor < co2Min) co2Min = co2.valor;
      if (co2.valor > co2Max) co2Max = co2.valor;
    }
  } else if (strcmp(topic, "airward/mq7") == 0) {
    mq7.valor = doc["voltaje"];
    mq7.ultimo = millis();
  }
}

// ---------------------------------------------------------------
// Conexiones sin bloquear: así la pantalla y el AHT10 siguen
// funcionando aunque se caiga el WiFi o el broker.
// ---------------------------------------------------------------
void mantenerConexiones() {
  if (millis() - ultimoIntento < INTERVALO_REINTENTO) return;

  if (WiFi.status() != WL_CONNECTED) {
    ultimoIntento = millis();
    Serial.println("WiFi desconectado, reintentando...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    return;
  }

  if (!mqtt.connected()) {
    ultimoIntento = millis();
    Serial.print("Conectando a MQTT...");
    if (mqtt.connect(MQTT_CLIENT_ID, MQTT_TOPIC_STATUS, 1, true, "offline")) {
      Serial.println(" conectado.");
      mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
      mqtt.subscribe(MQTT_TOPIC_SUSCRIBIR);
    } else {
      Serial.printf(" falló, rc=%d\n", mqtt.state());
    }
  }
}

// ---------------------------------------------------------------
// Pantalla: niveles y utilidades
// (solo ASCII: la fuente de Adafruit GFX no tiene tildes ni ñ)
// ---------------------------------------------------------------
const uint16_t COL_TRACK = 0x2104;       // gris oscuro (fondo de barras)
const uint16_t COL_VERDE_T = 0x0320;     // tonos tenues para las zonas de las escalas
const uint16_t COL_AMARILLO_T = 0x4200;
const uint16_t COL_ROJO_T = 0x4000;
const uint16_t COL_CYAN_T = 0x0208;

enum Nivel { N_NINGUNO, N_BUENO, N_MEDIO, N_ALTO };

uint16_t colorNivel(Nivel n) {
  switch (n) {
    case N_BUENO: return ILI9341_GREEN;
    case N_MEDIO: return ILI9341_YELLOW;
    case N_ALTO:  return ILI9341_RED;
    default:      return ILI9341_DARKGREY;
  }
}

Nivel nivelCO2(float ppm) {
  if (ppm <= 0) return N_NINGUNO;
  if (ppm >= 1200) return N_ALTO;
  if (ppm >= 800) return N_MEDIO;
  return N_BUENO;
}
Nivel nivelTemp(float c) { return (c < 18 || c > 27) ? N_MEDIO : N_BUENO; }
Nivel nivelHum(float h) { return (h < 30 || h > 65) ? N_MEDIO : N_BUENO; }

const char* textoTemp(float c) { return c < 18 ? "Fresco" : (c > 27 ? "Caluroso" : "Confortable"); }
const char* textoHum(float h) { return h < 30 ? "Seco" : (h > 65 ? "Humedo" : "Confortable"); }

bool datoVigente(const DatoRemoto& d) {
  return d.ultimo != 0 && (millis() - d.ultimo) < TIMEOUT_DATO_MS;
}

// Texto sobre fondo negro, relleno con espacios para tapar el valor anterior (sin parpadeo).
void texto(int x, int y, uint8_t tam, uint16_t color, const char* s, int anchoChars = 0) {
  char buf[40];
  if (anchoChars > 0) snprintf(buf, sizeof(buf), "%-*s", anchoChars, s);
  else snprintf(buf, sizeof(buf), "%s", s);
  tft.setTextSize(tam);
  tft.setTextColor(color, ILI9341_BLACK);
  tft.setCursor(x, y);
  tft.print(buf);
}

// Barra con zonas de color tenues + marcador blanco triangular encima.
// frac = 0..1 posición del valor. Solo redibuja si el marcador se movió (slot = 0..3).
int ultimoPx[4];
void barraEscala(int slot, int x, int y, int w, int h, float frac, const float* hasta, const uint16_t* col, int n, bool forzar) {
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;
  int px = x + (int)(frac * (w - 1));
  if (!forzar && px == ultimoPx[slot]) return;
  ultimoPx[slot] = px;
  float desde = 0;
  for (int i = 0; i < n; i++) {
    int x0 = x + (int)(desde * w);
    int x1 = x + (int)(hasta[i] * w);
    tft.fillRect(x0, y, x1 - x0, h, col[i]);
    desde = hasta[i];
  }
  tft.fillRect(x - 8, y - 11, w + 16, 10, ILI9341_BLACK);
  tft.fillTriangle(px - 6, y - 10, px + 6, y - 10, px, y - 1, ILI9341_WHITE);
}

// Barra de relleno proporcional (panel resumen).
void barraRelleno(int x, int y, int w, int h, float frac, uint16_t color) {
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;
  int ancho = (int)(frac * w);
  tft.fillRect(x, y, ancho, h, color);
  tft.fillRect(x + ancho, y, w - ancho, h, COL_TRACK);
}

// ---------------------------------------------------------------
// Pantallas rotativas
// ---------------------------------------------------------------
enum Pagina { P_RESUMEN, P_CO2, P_CO, P_AMBIENTE, P_BARRAS, P_TOTAL };
int pagina = P_RESUMEN;
int cambiosPagina = 0;

bool paginaDisponible(int p) {
  if (p == P_CO2) return datoVigente(co2);
  if (p == P_CO) return datoVigente(mq7);
  return true;  // resumen, ambiente y barras siempre
}

void encabezado(const char* titulo, uint16_t color) {
  tft.fillScreen(ILI9341_BLACK);
  tft.setTextSize(2);
  tft.setTextColor(color);
  tft.setCursor(10, 9);
  tft.print(titulo);
  // puntos indicadores de pantalla
  for (int i = 0; i < P_TOTAL; i++) {
    int cx = 320 - 12 - (P_TOTAL - 1 - i) * 16;
    if (i == pagina) tft.fillCircle(cx, 17, 5, ILI9341_CYAN);
    else tft.drawCircle(cx, 17, 4, ILI9341_DARKGREY);
  }
  tft.drawFastHLine(0, 34, 320, ILI9341_DARKGREY);
  for (int i = 0; i < 4; i++) ultimoPx[i] = -1000;
}

void mostrarEstado() {
  char buf[40];
  snprintf(buf, sizeof(buf), "WiFi:%s  MQTT:%s   ",
           WiFi.status() == WL_CONNECTED ? "OK" : "--",
           mqtt.connected() ? "OK" : "--");
  texto(10, 228, 1, ILI9341_DARKGREY, buf);
}

// --- P_RESUMEN: lista de los 4 valores ---
void plantillaResumen() {
  encabezado("AirWard", ILI9341_CYAN);
  tft.setTextSize(2);
  tft.setTextColor(ILI9341_LIGHTGREY);
  tft.setCursor(10, 60);  tft.print("Temperatura");
  tft.setCursor(10, 105); tft.print("Humedad");
  tft.setCursor(10, 150); tft.print("CO2");
  tft.setCursor(10, 195); tft.print("CO (MQ7)");
}

void valorResumen(int y, const char* s, uint16_t color) {
  texto(170, y, 3, color, s, 8);
}

void actualizarResumen() {
  char txt[16];
  if (ahtOk) {
    snprintf(txt, sizeof(txt), "%.1f C", tempLocal);
    valorResumen(56, txt, ILI9341_WHITE);
    snprintf(txt, sizeof(txt), "%.0f %%", humLocal);
    valorResumen(101, txt, ILI9341_WHITE);
  } else {
    valorResumen(56, "ERROR", ILI9341_RED);
    valorResumen(101, "ERROR", ILI9341_RED);
  }
  if (datoVigente(co2)) {
    snprintf(txt, sizeof(txt), "%.0f ppm", co2.valor);
    valorResumen(146, txt, colorNivel(nivelCO2(co2.valor)));
  } else {
    valorResumen(146, "---", ILI9341_DARKGREY);
  }
  if (datoVigente(mq7)) {
    snprintf(txt, sizeof(txt), "%.2f V", mq7.valor);
    valorResumen(191, txt, ILI9341_WHITE);
  } else {
    valorResumen(191, "---", ILI9341_DARKGREY);
  }
}

// --- P_CO2: detalle del MH-Z19 ---
void plantillaCO2() {
  encabezado("CO2  MH-Z19", ILI9341_CYAN);
  texto(165, 76, 3, ILI9341_LIGHTGREY, "ppm");
  tft.setTextSize(1);
  tft.setTextColor(ILI9341_DARKGREY);
  tft.setCursor(10, 172);  tft.print("400");
  tft.setCursor(76, 172);  tft.print("800");
  tft.setCursor(148, 172); tft.print("1200");
  tft.setCursor(286, 172); tft.print("2000");
}

void actualizarCO2(bool forzar) {
  char txt[32];
  static const float hasta[] = {0.25, 0.5, 1.0};
  static const uint16_t col[] = {COL_VERDE_T, COL_AMARILLO_T, COL_ROJO_T};
  bool ok = datoVigente(co2);
  Nivel n = ok ? nivelCO2(co2.valor) : N_NINGUNO;
  uint16_t c = colorNivel(n);

  if (ok) snprintf(txt, sizeof(txt), "%.0f", co2.valor); else snprintf(txt, sizeof(txt), "---");
  texto(10, 50, 6, ok ? c : ILI9341_DARKGREY, txt, 4);

  tft.fillCircle(285, 78, 18, c);
  const char* msg = !ok ? "Sin datos del sensor"
                  : n == N_BUENO ? "Buena calidad de aire"
                  : n == N_MEDIO ? "Regular: ventilar pronto"
                  : n == N_ALTO ? "Mala: ventilar ya" : "Sin lectura";
  texto(10, 112, 2, ok ? c : ILI9341_DARKGREY, msg, 25);

  float frac = ok ? (co2.valor - 400.0) / 1600.0 : 0;
  barraEscala(0, 10, 152, 300, 16, frac, hasta, col, 3, forzar);

  if (co2Max > 0) snprintf(txt, sizeof(txt), "Min %.0f  Max %.0f", co2Min, co2Max);
  else snprintf(txt, sizeof(txt), " ");
  texto(10, 192, 2, ILI9341_LIGHTGREY, txt, 25);
}

// --- P_CO: detalle del MQ-7 (voltaje crudo) ---
void plantillaCO() {
  encabezado("CO  MQ-7", ILI9341_CYAN);
  texto(200, 76, 3, ILI9341_LIGHTGREY, "V");
  tft.setTextSize(1);
  tft.setTextColor(ILI9341_DARKGREY);
  tft.setCursor(10, 172);  tft.print("0 V");
  tft.setCursor(150, 172); tft.print("2.5");
  tft.setCursor(292, 172); tft.print("5 V");
  tft.setTextColor(ILI9341_LIGHTGREY);
  tft.setCursor(10, 196); tft.print("Tension cruda del sensor. Para pasarla a ppm");
  tft.setCursor(10, 208); tft.print("hay que calibrarlo con aire limpio y gas patron.");
}

void actualizarCO(bool forzar) {
  char txt[16];
  static const float hasta[] = {1.0};
  static const uint16_t col[] = {COL_CYAN_T};
  bool ok = datoVigente(mq7);
  if (ok) snprintf(txt, sizeof(txt), "%.2f", mq7.valor); else snprintf(txt, sizeof(txt), "---");
  texto(10, 50, 6, ok ? ILI9341_WHITE : ILI9341_DARKGREY, txt, 5);
  tft.fillCircle(285, 78, 18, ok ? ILI9341_CYAN : ILI9341_DARKGREY);
  texto(10, 112, 2, ok ? ILI9341_CYAN : ILI9341_DARKGREY, ok ? "Sin calibrar" : "Sin datos del sensor", 25);
  barraEscala(0, 10, 152, 300, 16, ok ? mq7.valor / 5.0 : 0, hasta, col, 1, forzar);
}

// --- P_AMBIENTE: temperatura y humedad (AHT10) ---
void plantillaAmbiente() {
  encabezado("Ambiente  AHT10", ILI9341_CYAN);
  texto(10, 40, 2, ILI9341_LIGHTGREY, "Temperatura");
  texto(10, 130, 2, ILI9341_LIGHTGREY, "Humedad");
  texto(135, 64, 3, ILI9341_LIGHTGREY, "C");
  texto(115, 154, 3, ILI9341_LIGHTGREY, "%");
  tft.setTextSize(1);
  tft.setTextColor(ILI9341_DARKGREY);
  tft.setCursor(10, 120);  tft.print("10");
  tft.setCursor(290, 120); tft.print("40 C");
  tft.setCursor(10, 210);  tft.print("0");
  tft.setCursor(282, 210); tft.print("100 %");
}

void actualizarAmbiente(bool forzar) {
  char txt[16];
  static const float hastaT[] = {8.0 / 30, 17.0 / 30, 1.0};
  static const uint16_t colT[] = {COL_AMARILLO_T, COL_VERDE_T, COL_AMARILLO_T};
  static const float hastaH[] = {0.30, 0.65, 1.0};
  static const uint16_t colH[] = {COL_AMARILLO_T, COL_VERDE_T, COL_AMARILLO_T};

  if (!ahtOk) {
    texto(10, 56, 4, ILI9341_RED, "ERROR", 8);
    texto(10, 146, 4, ILI9341_RED, "ERROR", 8);
    return;
  }
  snprintf(txt, sizeof(txt), "%.1f", tempLocal);
  texto(10, 56, 4, colorNivel(nivelTemp(tempLocal)), txt, 5);
  texto(180, 64, 2, colorNivel(nivelTemp(tempLocal)), textoTemp(tempLocal), 11);
  barraEscala(0, 10, 108, 300, 8, (tempLocal - 10.0) / 30.0, hastaT, colT, 3, forzar);

  snprintf(txt, sizeof(txt), "%.0f", humLocal);
  texto(10, 146, 4, colorNivel(nivelHum(humLocal)), txt, 4);
  texto(180, 154, 2, colorNivel(nivelHum(humLocal)), textoHum(humLocal), 11);
  barraEscala(1, 10, 198, 300, 8, humLocal / 100.0, hastaH, colH, 3, forzar);
}

// --- P_BARRAS: los 4 sensores de un vistazo ---
void plantillaBarras() {
  encabezado("Panel general", ILI9341_CYAN);
  texto(10, 44, 2, ILI9341_LIGHTGREY, "Temp");
  texto(10, 90, 2, ILI9341_LIGHTGREY, "Humedad");
  texto(10, 136, 2, ILI9341_LIGHTGREY, "CO2");
  texto(10, 182, 2, ILI9341_LIGHTGREY, "CO");
}

void filaBarras(int y, bool ok, Nivel n, const char* palabra, const char* valor, float frac, uint16_t colorBase) {
  uint16_t c = ok ? (n == N_NINGUNO ? colorBase : colorNivel(n)) : ILI9341_DARKGREY;
  texto(105, y, 2, c, ok ? palabra : "---", 8);
  texto(205, y, 2, ILI9341_WHITE, ok ? valor : "", 9);
  barraRelleno(10, y + 22, 300, 14, ok ? frac : 0, c);
}

void actualizarBarras() {
  char v[16];
  snprintf(v, sizeof(v), "%.1f C", tempLocal);
  filaBarras(44, ahtOk, nivelTemp(tempLocal), (tempLocal < 18 ? "Fresco" : (tempLocal > 27 ? "Calor" : "Normal")), v, (tempLocal - 10.0) / 30.0, ILI9341_CYAN);
  snprintf(v, sizeof(v), "%.0f %%", humLocal);
  filaBarras(90, ahtOk, nivelHum(humLocal), (humLocal < 30 ? "Seco" : (humLocal > 65 ? "Humedo" : "Normal")), v, humLocal / 100.0, ILI9341_CYAN);
  bool okC = datoVigente(co2);
  Nivel nc = nivelCO2(co2.valor);
  snprintf(v, sizeof(v), "%.0f ppm", co2.valor);
  filaBarras(136, okC, nc, nc == N_BUENO ? "Buena" : (nc == N_MEDIO ? "Regular" : "Mala"), v, (co2.valor - 400.0) / 1600.0, ILI9341_CYAN);
  bool okM = datoVigente(mq7);
  snprintf(v, sizeof(v), "%.2f V", mq7.valor);
  filaBarras(182, okM, N_NINGUNO, "Crudo", v, mq7.valor / 5.0, ILI9341_CYAN);
}

// ---------------------------------------------------------------
void dibujarPagina() {
  switch (pagina) {
    case P_RESUMEN:  plantillaResumen(); break;
    case P_CO2:      plantillaCO2(); break;
    case P_CO:       plantillaCO(); break;
    case P_AMBIENTE: plantillaAmbiente(); break;
    case P_BARRAS:   plantillaBarras(); break;
  }
}

void cambiarPagina() {
  int p = pagina;
  for (int i = 0; i < P_TOTAL; i++) {
    p = (p + 1) % P_TOTAL;
    if (paginaDisponible(p)) break;
  }
  pagina = p;
  cambiosPagina++;
  if (cambiosPagina % REINICIAR_TFT_CADA == 0) {
    // Si el controlador se resetea por una mala conexión, esto lo reconfigura.
    tft.begin();
    tft.setRotation(1);
  }
  dibujarPagina();
}

void actualizarPantalla(bool forzar) {
  switch (pagina) {
    case P_RESUMEN:  actualizarResumen(); break;
    case P_CO2:      actualizarCO2(forzar); break;
    case P_CO:       actualizarCO(forzar); break;
    case P_AMBIENTE: actualizarAmbiente(forzar); break;
    case P_BARRAS:   actualizarBarras(); break;
  }
  mostrarEstado();
}

// ---------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(500);

  tft.begin();
  tft.setRotation(1);  // horizontal: 320 x 240
  dibujarPagina();

#if AHT_SIMULADO
  ahtOk = true;
  tempLocal = SIM_TEMP;
  humLocal = SIM_HUM;
  Serial.println("AHT10 SIMULADO: temperatura y humedad fijas");
#else
  Wire.begin(21, 22);  // SDA, SCL
  ahtOk = aht.begin();
  Serial.println(ahtOk ? "AHT10 OK" : "No se encontró el AHT10 (SDA=21, SCL=22)");
#endif

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(onMensaje);
  ultimoCambioPagina = millis();
}

void loop() {
  LedTest();
  mantenerConexiones();
  if (mqtt.connected()) mqtt.loop();

  unsigned long ahora = millis();

  if (ahora - ultimaPublicacion >= INTERVALO_PUBLICACION) {
    ultimaPublicacion = ahora;

    if (ahtOk) {
#if !AHT_SIMULADO
      sensors_event_t humedad, temp;
      aht.getEvent(&humedad, &temp);
      tempLocal = temp.temperature;
      humLocal = humedad.relative_humidity;
#endif
      if (mqtt.connected()) {
        StaticJsonDocument<160> doc;
        doc["id_nodo"] = "aht10";
        doc["temp"] = tempLocal;
        doc["humedad"] = humLocal;
        doc["uptime_ms"] = millis();
#if AHT_SIMULADO
        doc["simulado"] = true;
#endif
        char buffer[160];
        size_t n = serializeJson(doc, buffer);
        bool ok = mqtt.publish(MQTT_TOPIC_DATOS, buffer, n);
        Serial.printf("Publicado en %s: %s -> %s\n", MQTT_TOPIC_DATOS, buffer, ok ? "OK" : "FALLÓ");
      }
    }
  }

  bool cambio = false;
  if (ahora - ultimoCambioPagina >= INTERVALO_PAGINA) {
    ultimoCambioPagina = ahora;
    cambiarPagina();
    cambio = true;
  }

  if (cambio || ahora - ultimaPantalla >= INTERVALO_PANTALLA) {
    ultimaPantalla = ahora;
    actualizarPantalla(cambio);
  }
}
