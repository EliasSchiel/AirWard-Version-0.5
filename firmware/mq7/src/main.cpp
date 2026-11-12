#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// --- WiFi y broker: se definen en include/secrets.h (copiar de secrets.h.example) ---
#include "secrets.h"

// --- MQTT (el puerto 1883 es el del broker Mosquitto en Docker) ---
const int MQTT_PORT = 1883;

// --- MQTT ---
const char* MQTT_CLIENT_ID = "airward-mq7";
const char* MQTT_TOPIC_DATOS = "airward/mq7";
const char* MQTT_TOPIC_STATUS = "airward/mq7/status";

// --- Sensor MQ7 ---
const int MQ7_PIN = 34;            // ADC1, solo-entrada
const int NUM_LECTURAS = 10;
const float DIVISOR_RATIO = 0.6;   // divisor 10k / 15k
const unsigned long INTERVALO_PUBLICACION = 2000;

WiFiClient espClient;
PubSubClient mqtt(espClient);
unsigned long ultimoEnvio = 0;

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

  conectarWiFi();
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) conectarWiFi();
  if (!mqtt.connected()) conectarMQTT();
  mqtt.loop();

  if (millis() - ultimoEnvio >= INTERVALO_PUBLICACION) {
    ultimoEnvio = millis();

    long sumaMv = 0;
    for (int i = 0; i < NUM_LECTURAS; i++) {
      sumaMv += analogReadMilliVolts(MQ7_PIN);
      delay(10);
    }
    float voltajeADC = (sumaMv / (float)NUM_LECTURAS) / 1000.0;
    float voltajeSensor = voltajeADC / DIVISOR_RATIO;

    StaticJsonDocument<128> doc;
    doc["id_nodo"] = "mq7";
    doc["voltaje"] = voltajeSensor;
    doc["uptime_ms"] = millis();

    char buffer[128];
    size_t n = serializeJson(doc, buffer);

    bool ok = mqtt.publish(MQTT_TOPIC_DATOS, buffer, n);
    Serial.printf("Publicado en %s: %s -> %s\n", MQTT_TOPIC_DATOS, buffer, ok ? "OK" : "FALLÓ");
    LedTest();
  }
}
