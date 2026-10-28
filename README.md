# AirWard

Sistema de monitoreo de la calidad del aire en ambientes cerrados. Tres nodos **ESP32** miden CO₂, CO, temperatura y humedad y publican sus lecturas por **WiFi con MQTT** a un broker **Mosquitto** en **Docker**. Los datos se ven en tiempo real en una **pantalla TFT** (nodo principal) y en una **página web** con tarjetas, gráficos y un mapa 3D de la red.

> Proyecto universitario de 2026 · Elias Schiel, Facundo Kern, Solange Gerbuez y Manuel Ponce. Presentado en la exposición final del 21/10/2026.

## Cómo funciona

```
MQ7 (CO) ──────┐
MH-Z19 (CO₂) ──┼─ WiFi / MQTT ─▶ Mosquitto (Docker) ─┬─▶ Nodo principal (pantalla TFT)
Principal ─────┘                                      └─▶ Web (nginx + WebSocket)
(AHT10 + TFT)
```

| Nodo | Sensor | Tópico MQTT |
|---|---|---|
| `mhz19` | MH-Z19 (CO₂, UART) | `airward/mhz19` |
| `mq7` | MQ-7 (CO, analógico) | `airward/mq7` |
| `principal` | AHT10 + pantalla ILI9341 | `airward/aht10` (se suscribe a `airward/#`) |

Cada nodo publica además `airward/<nodo>/status` (`online` retenido y `offline` como testamento).

## Estructura del repositorio

```
firmware/   un proyecto PlatformIO por nodo (mq7, mhz19, principal)
server/     docker-compose.yml, configuración de Mosquitto y la página web
hardware/   piezas 3D y etiquetas
docs/       informe y presentación
```

## Puesta en marcha

### 1. Servidor (broker + web)

Requiere Docker. Desde la carpeta `server/`:

```bash
docker compose up -d
```

Habilitá en el firewall los puertos **1883** (MQTT), **9001** (WebSocket) y **8080** (web). La página queda en `http://IP_DE_LA_PC:8080`. Para probarla sin hardware: `http://IP_DE_LA_PC:8080/?demo=1`.

### 2. Firmware de los nodos

Requiere VS Code con la extensión PlatformIO. Para cada carpeta de `firmware/`:

1. Copiá `include/secrets.h.example` como `include/secrets.h` y completá tu red WiFi (2,4 GHz) y la IP de la PC con Docker (`ipconfig` en Windows).
2. Conectá el ESP32 por USB y ejecutá **Upload**.

`secrets.h` está en `.gitignore`: tus credenciales no se suben al repositorio.

### 3. Conexiones

| Nodo | Conexión al ESP32 |
|---|---|
| MH-Z19 | UART2: sensor TX → GPIO 16, sensor RX → GPIO 17 (9600 baudios, 5 V) |
| MQ-7 | AO → divisor 10 kΩ / 15 kΩ → GPIO 34 (ADC1) |
| AHT10 | I²C: SDA → GPIO 21, SCL → GPIO 22 |
| ILI9341 | CS 5 · RST 16 · DC 17 · MOSI 23 · SCK 18 |

## Estado y limitaciones

- En esta versión, la temperatura y la humedad del nodo principal están **simuladas** (`AHT_SIMULADO 1` en `firmware/principal/src/main.cpp`). Poné el valor en `0` para usar el AHT10 real.
- El broker usa `allow_anonymous true` y está pensado para una red local. Para exponerlo en internet, configurá usuarios y TLS.
- AirWard no reemplaza a un detector de monóxido de carbono certificado.

## Próximos pasos

- Servidor en la nube con MQTT sobre TLS y usuarios.
- Historial en base de datos y API para aplicaciones móviles.
- Avisos al celular y más nodos por ambiente.

## Tecnologías

ESP32 (Arduino / PlatformIO) · MQTT (PubSubClient) · Mosquitto · Docker Compose · nginx · mqtt.js · three.js
