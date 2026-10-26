/**
 * @file device_manifest.c
 * @brief Reference implementation of Device Configuration Manifest for STM32 / FreeRTOS
 */

#include "device_config.h"
#include <stdio.h>
#include <string.h>

void DeviceConfig_Init(DeviceManifest_t *manifest) {
    if (!manifest) return;
    memset(manifest, 0, sizeof(DeviceManifest_t));

    // 1. Core Identifiers (Read from EEPROM, Flash OTP, or Compile-time config)
    strncpy(manifest->thing_name, "LC-0001-01", STR_LEN_SHORT);
    strncpy(manifest->serial_number, "LC-0001-01", STR_LEN_SHORT);
    strncpy(manifest->device_type, "MASTER", 16);

    // 2. Hardware specs
    strncpy(manifest->hardware.hardware_version, "rev2.1", STR_LEN_SHORT);
    strncpy(manifest->hardware.mcu, "STM32F401RET6 ARM Cortex-M4 @ 84MHz", STR_LEN_MID);
    strncpy(manifest->hardware.modem, "SIM7600G-H LTE CAT-4", STR_LEN_MID);
    strncpy(manifest->hardware.imei, "864205041234567", STR_LEN_SHORT); // Read via AT+GSN from modem
    strncpy(manifest->hardware.mac_address, "A4:CF:12:89:BC:44", STR_LEN_SHORT);

    // 3. Firmware specs
    strncpy(manifest->firmware.version, "v2.1.4", STR_LEN_SHORT);
    strncpy(manifest->firmware.build_date, __DATE__ " " __TIME__, STR_LEN_SHORT);
    strncpy(manifest->firmware.git_commit, "a3f8c9b", 16);
    strncpy(manifest->firmware.bootloader_version, "v1.0.2", 16);

    // 4. Manufacturing details
    strncpy(manifest->manufacturing.manufacturer, "Mirtha / LC-Platform", STR_LEN_MID);
    strncpy(manifest->manufacturing.model_number, "LC-GATE-MASTER-V2", STR_LEN_MID);
    strncpy(manifest->manufacturing.batch_number, "BATCH-2024-Q3", STR_LEN_SHORT);
    strncpy(manifest->manufacturing.date_of_mfg, "2024-05-15", STR_LEN_SHORT);

    // 5. Runtime Config
    manifest->runtime_config.telemetry_interval_sec = 10;
    manifest->runtime_config.heartbeat_interval_sec = 60;
    manifest->runtime_config.battery_low_threshold_v = 11.8f;
    manifest->runtime_config.solar_cutin_voltage_v = 13.2f;

    // 6. Internal Sensors Manifest (Define exact sensors soldered / connected)
    manifest->sensors_count = 4;

    // Sensor 1: Solar Voltage
    strncpy(manifest->sensors[0].id, "solar_voltage", STR_LEN_SHORT);
    strncpy(manifest->sensors[0].name, "Solar Panel Voltage Monitor", STR_LEN_MID);
    strncpy(manifest->sensors[0].type, "VOLTAGE_ADC", STR_LEN_SHORT);
    strncpy(manifest->sensors[0].bus_interface, "ADC1_IN0", STR_LEN_SHORT);
    strncpy(manifest->sensors[0].pin_or_address, "PA0", STR_LEN_SHORT);
    strncpy(manifest->sensors[0].unit, "V", 16);
    strncpy(manifest->sensors[0].range, "0-30V", STR_LEN_SHORT);
    manifest->sensors[0].calibration_factor = 11.0f;

    // Sensor 2: Battery Shunt Current
    strncpy(manifest->sensors[1].id, "battery_current", STR_LEN_SHORT);
    strncpy(manifest->sensors[1].name, "LiFePO4 Shunt Current Monitor", STR_LEN_MID);
    strncpy(manifest->sensors[1].type, "CURRENT_SHUNT", STR_LEN_SHORT);
    strncpy(manifest->sensors[1].bus_interface, "I2C1", STR_LEN_SHORT);
    strncpy(manifest->sensors[1].pin_or_address, "0x40", STR_LEN_SHORT);
    strncpy(manifest->sensors[1].unit, "A", 16);
    strncpy(manifest->sensors[1].range, "-30A to +30A", STR_LEN_SHORT);
    manifest->sensors[1].calibration_factor = 1.0f;

    // Sensor 3: Inclinometer
    strncpy(manifest->sensors[2].id, "boom_angle", STR_LEN_SHORT);
    strncpy(manifest->sensors[2].name, "Boom Barrier Inclinometer", STR_LEN_MID);
    strncpy(manifest->sensors[2].type, "INCLINOMETER", STR_LEN_SHORT);
    strncpy(manifest->sensors[2].bus_interface, "I2C1", STR_LEN_SHORT);
    strncpy(manifest->sensors[2].pin_or_address, "0x68", STR_LEN_SHORT);
    strncpy(manifest->sensors[2].unit, "deg", 16);
    strncpy(manifest->sensors[2].range, "0-90 deg", STR_LEN_SHORT);
    manifest->sensors[2].calibration_factor = 1.0f;

    // Sensor 4: Train Approach Doppler Radar
    strncpy(manifest->sensors[3].id, "train_radar", STR_LEN_SHORT);
    strncpy(manifest->sensors[3].name, "Train Approach Doppler Radar", STR_LEN_MID);
    strncpy(manifest->sensors[3].type, "RADAR", STR_LEN_SHORT);
    strncpy(manifest->sensors[3].bus_interface, "USART2", STR_LEN_SHORT);
    strncpy(manifest->sensors[3].pin_or_address, "PA2/PA3", STR_LEN_SHORT);
    strncpy(manifest->sensors[3].unit, "km/h", 16);
    strncpy(manifest->sensors[3].range, "0-160 km/h", STR_LEN_SHORT);
    manifest->sensors[3].calibration_factor = 1.0f;

    // 7. Embedded Components Manifest
    manifest->components_count = 4;
    strncpy(manifest->components[0].name, "Main Controller MCU", STR_LEN_MID);
    strncpy(manifest->components[0].model, "STM32F401 Blackpill", STR_LEN_MID);
    strncpy(manifest->components[0].spec, "ARM Cortex-M4 84MHz, 256KB Flash, 64KB RAM", STR_LEN_LONG);
    strncpy(manifest->components[0].vendor, "STMicroelectronics", STR_LEN_SHORT);

    strncpy(manifest->components[1].name, "Cellular LTE Modem", STR_LEN_MID);
    strncpy(manifest->components[1].model, "SIM7600G-H", STR_LEN_MID);
    strncpy(manifest->components[1].spec, "LTE Cat-4 Global Bands + GNSS GPS/GLONASS", STR_LEN_LONG);
    strncpy(manifest->components[1].vendor, "SIMCom", STR_LEN_SHORT);

    strncpy(manifest->components[2].name, "Solar MPPT Controller", STR_LEN_MID);
    strncpy(manifest->components[2].model, "MPPT 12V 10A Intelligent", STR_LEN_MID);
    strncpy(manifest->components[2].spec, "Synchronous Buck MPPT, 98% efficiency", STR_LEN_LONG);
    strncpy(manifest->components[2].vendor, "OEM", STR_LEN_SHORT);

    strncpy(manifest->components[3].name, "Deep-Cycle Battery Pack", STR_LEN_MID);
    strncpy(manifest->components[3].model, "LiFePO4 12.8V 24Ah", STR_LEN_MID);
    strncpy(manifest->components[3].spec, "4S LiFePO4 with Integrated Active BMS", STR_LEN_LONG);
    strncpy(manifest->components[3].vendor, "OEM", STR_LEN_SHORT);
}

int DeviceConfig_SerializeJson(const DeviceManifest_t *m, char *buf, size_t max_len) {
    if (!m || !buf || max_len < 1024) return -1;

    char sensors_json[1500] = {0};
    char *s_ptr = sensors_json;
    size_t s_rem = sizeof(sensors_json);

    strcat(sensors_json, "[");
    for (int i = 0; i < m->sensors_count; i++) {
        char item[300];
        snprintf(item, sizeof(item),
            "{\"id\":\"%s\",\"name\":\"%s\",\"type\":\"%s\",\"interface\":\"%s\",\"pin\":\"%s\",\"unit\":\"%s\",\"range\":\"%s\",\"calFactor\":%.2f}%s",
            m->sensors[i].id, m->sensors[i].name, m->sensors[i].type,
            m->sensors[i].bus_interface, m->sensors[i].pin_or_address,
            m->sensors[i].unit, m->sensors[i].range, m->sensors[i].calibration_factor,
            (i == m->sensors_count - 1) ? "" : ",");
        strncat(sensors_json, item, s_rem - strlen(sensors_json) - 1);
    }
    strcat(sensors_json, "]");

    char comps_json[1200] = {0};
    strcat(comps_json, "[");
    for (int i = 0; i < m->components_count; i++) {
        char item[250];
        snprintf(item, sizeof(item),
            "{\"name\":\"%s\",\"model\":\"%s\",\"spec\":\"%s\",\"vendor\":\"%s\"}%s",
            m->components[i].name, m->components[i].model, m->components[i].spec, m->components[i].vendor,
            (i == m->components_count - 1) ? "" : ",");
        strncat(comps_json, item, sizeof(comps_json) - strlen(comps_json) - 1);
    }
    strcat(comps_json, "]");

    int written = snprintf(buf, max_len,
        "{"
        "\"thingName\":\"%s\","
        "\"serialNumber\":\"%s\","
        "\"deviceType\":\"%s\","
        "\"hardware\":{\"version\":\"%s\",\"mcu\":\"%s\",\"modem\":\"%s\",\"imei\":\"%s\",\"macAddress\":\"%s\"},"
        "\"firmware\":{\"version\":\"%s\",\"buildDate\":\"%s\",\"gitCommit\":\"%s\",\"bootloader\":\"%s\"},"
        "\"manufacturing\":{\"manufacturer\":\"%s\",\"modelNumber\":\"%s\",\"batchNumber\":\"%s\",\"dateOfMfg\":\"%s\"},"
        "\"runtimeConfig\":{\"telemetryIntervalSec\":%u,\"heartbeatIntervalSec\":%u,\"batteryLowThresholdV\":%.2f,\"solarCutinVoltageV\":%.2f},"
        "\"sensors\":%s,"
        "\"components\":%s"
        "}",
        m->thing_name, m->serial_number, m->device_type,
        m->hardware.hardware_version, m->hardware.mcu, m->hardware.modem, m->hardware.imei, m->hardware.mac_address,
        m->firmware.version, m->firmware.build_date, m->firmware.git_commit, m->firmware.bootloader_version,
        m->manufacturing.manufacturer, m->manufacturing.model_number, m->manufacturing.batch_number, m->manufacturing.date_of_mfg,
        m->runtime_config.telemetry_interval_sec, m->runtime_config.heartbeat_interval_sec,
        m->runtime_config.battery_low_threshold_v, m->runtime_config.solar_cutin_voltage_v,
        sensors_json, comps_json
    );

    return written;
}

/**
 * @brief Publishes the device hardware and sensor manifest to AWS IoT Core over MQTT.
 * 
 * Target Topic: `lc/devices/<thingName>/manifest`
 * Protocol: MQTT over TLS (Port 8883) with X.509 client certificate
 * 
 * Example SIM7600G UART AT Command Sequence:
 * 1. AT+CMQTTSTART
 * 2. AT+CMQTTACCQ=0,"<thingName>",1
 * 3. AT+CMQTTSSLCFG=0,0
 * 4. AT+CMQTTCONNECT=0,"tcp://<iot-endpoint>:8883",60,1
 * 5. AT+CMQTTTOPIC=0,<topic_len> -> send "lc/devices/<thingName>/manifest"
 * 6. AT+CMQTTPAYLOAD=0,<payload_len> -> send JSON
 * 7. AT+CMQTTPUB=0,1,60
 */
bool DeviceConfig_PublishToCloud(const DeviceManifest_t *manifest) {
    if (!manifest) return false;

    static char payload_buffer[3072];
    int json_len = DeviceConfig_SerializeJson(manifest, payload_buffer, sizeof(payload_buffer));
    if (json_len <= 0) {
        printf("[ERROR] Failed to serialize device manifest to JSON\r\n");
        return false;
    }

    char topic[128];
    snprintf(topic, sizeof(topic), "lc/devices/%s/manifest", manifest->thing_name);

    printf("[MQTT PUBLISH] Topic: %s (Size: %d bytes)\r\n", topic, json_len);
    printf("[PAYLOAD]: %s\r\n", payload_buffer);

    /* 
     * --- SIM7600G UART HAL Transmission Hook ---
     * In production on STM32, pass topic and payload_buffer to your 
     * SIM7600_MQTT_Publish(topic, payload_buffer, json_len, QoS=1) driver:
     * 
     * int status = SIM7600_MQTT_Publish(topic, payload_buffer, json_len, 1);
     * return (status == 0);
     */

    return true;
}

