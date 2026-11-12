#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <MHZ19.h>

// --- WiFi y broker: se definen en include/secrets.h (copiar de secrets.h.example) ---
#include "secrets.h"

// --- MQTT (el puerto 1883 es el del broker Mosquitto en Docker) ---
const int MQTT_PORT = 1883;

// --- MQTT ---
const char* MQTT_CLIENT_ID = "airward-mhz19";
const char* MQTT_TOPIC_DATOS = "airward/mhz19";
const char* MQTT_TOPIC_STATUS = "airward/mhz19/status";

// --- Sensor MHZ-19 (UART2) ---
#define MHZ19_RX 16  // RX2 del ESP32 <- TX del sensor
#define MHZ19_TX 17  // TX2 del ESP32 -> RX del sensor
MHZ19 mhz19;
HardwareSerial mhzSerial(2);

const unsigned long INTERVALO_PUBLICACION = 2000;

WiFiClient espClient;
PubSubClient mqtt(espClient);
unsigned long ultimoEnvio = 0;

//--- LED TEST para la actividad del 10/11
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
   

    
  blink = !blink;
  AJUSTAR_LED_TEST(blink);

  }



void conectarWiFi() {
  WiFi.disconnect(true, true);
  delay(200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.printf("Conectando a '%s'", WIFI_SSID);
  int intentos = 0;
  while (WiFi.status() != WL_CONNECTED && intentos < 30) {
    delay(500);
    Serial.print(".");
    intentos++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi conectado. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.printf("\nNo se pudo conectar. Último estado: %d\n", WiFi.status());
  }
}

void conectarMQTT() {
  while (!mqtt.connected()) {
    Serial.print("Conectando a MQTT...");
    if (mqtt.connect(MQTT_CLIENT_ID, MQTT_TOPIC_STATUS, 1, true, "offline")) {
      Serial.println(" conectado.");
      mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
    } else {
      Serial.printf(" falló, rc=%d. Reintento en 2s\n", mqtt.state());
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  mhzSerial.begin(9600, SERIAL_8N1, MHZ19_RX, MHZ19_TX);
  mhz19.begin(mhzSerial);
  mhz19.autoCalibration(false);  // en interiores no se cumple la asunción de aire limpio diario
  Serial.println("MHZ-19 inicializado. Precalentamiento: ~3 minutos.");

  conectarWiFi();
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) conectarWiFi();
  if (!mqtt.connected()) conectarMQTT();
  mqtt.loop();

  if (millis() - ultimoEnvio >= INTERVALO_PUBLICACION) {
    ultimoEnvio = millis();

    int co2 = mhz19.getCO2();
    int8_t temp = mhz19.getTemperature();

    StaticJsonDocument<128> doc;
    doc["id_nodo"] = "mhz19";
    doc["co2_ppm"] = co2;
    doc["temp_estimada"] = temp;
    doc["uptime_ms"] = millis();

    char buffer[128];
    size_t n = serializeJson(doc, buffer);

    bool ok = mqtt.publish(MQTT_TOPIC_DATOS, buffer, n);
    Serial.printf("Publicado en %s: %s -> %s\n", MQTT_TOPIC_DATOS, buffer, ok ? "OK" : "FALLÓ");
    LedTest();
  }
}
