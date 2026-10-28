/**
 * @file device_health.c
 * @brief Reference Implementation of On-Demand Health Diagnostic Handler
 * 
 * Hardware Target: STM32F401 / SIM7600G-H LTE CAT-4
 * Communication: MQTT over TLS (Port 8883) to AWS IoT Core
 * 
 * This file implements the complete flow:
 * 1. Subscribes to `lc-gate/<thingName>/health/request`
 * 2. Parses incoming JSON commands: {"action":"HEALTH_CHECK", "requestId":"hc_...", ...}
 * 3. Samples active ADCs, GPIOs, SIM7600 AT commands, and I2C sensors
 * 4. Publishes diagnostic response to `lc-gate/<thingName>/health`
 */

#include "device_health.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static char g_thing_name[32] = "LC-M-001";
static uint32_t g_boot_time_sec = 0;

/* ========================================================================= */
/*                          HARDWARE HAL STUB HOOKS                          */
/*   (Replace these stubs with your real STM32 HAL / FreeRTOS driver calls)  */
/* ========================================================================= */

/**
 * @brief Reads Battery Voltage via ADC1_IN1 (Voltage Divider: 100k/10k)
 */
static float HAL_Read_Battery_Voltage(void) {
    /* STM32 HAL Example:
     * HAL_ADC_Start(&hadc1);
     * HAL_ADC_PollForConversion(&hadc1, 10);
     * uint32_t raw = HAL_ADC_GetValue(&hadc1);
     * return (raw * 3.3f / 4095.0f) * 11.0f;
     */
    return 12.65f; /* 12.65 Volts */
}

/**
 * @brief Calculates Battery State-of-Charge Percentage
 */
static uint8_t HAL_Compute_Battery_Percentage(float voltage) {
    if (voltage >= 13.3f) return 100;
    if (voltage <= 11.8f) return 5;
    return (uint8_t)(((voltage - 11.8f) / (13.3f - 11.8f)) * 95.0f + 5.0f);
}

/**
 * @brief Reads Solar Panel Voltage via ADC1_IN0
 */
static float HAL_Read_Solar_Voltage(void) {
    return 18.42f; /* 18.42 Volts under daylight */
}

/**
 * @brief Queries SIM7600 modem via UART for CSQ (Cellular Signal Quality)
 * AT Command: "AT+CSQ" -> returns "+CSQ: 24,0"
 */
static int8_t HAL_Read_Modem_CSQ(void) {
    /* In production: Send "AT+CSQ\r\n" to USART1, parse first integer */
    return 24; /* 24 CSQ (~ -65 dBm, Good 4G signal) */
}

/**
 * @brief Reads Physical Limit Switch GPIO (PE2 with pull-up)
 * Low = Closed, High = Open
 */
static bool HAL_Read_Limit_Switch(void) {
    /* return (HAL_GPIO_ReadPin(GPIOE, GPIO_PIN_2) == GPIO_PIN_RESET); */
    return true; /* Closed */
}

/**
 * @brief Reads Hall Effect Sensor GPIO (PE3 with pull-up)
 */
static bool HAL_Read_Hall_Effect(void) {
    /* return (HAL_GPIO_ReadPin(GPIOE, GPIO_PIN_3) == GPIO_PIN_RESET); */
    return true; /* Closed */
}

/**
 * @brief Reads Inclinometer Boom Angle over I2C1
 */
static float HAL_Read_Boom_Angle(void) {
    return 0.5f; /* 0.5 degrees (Barrier horizontal / Closed) */
}

/**
 * @brief Reads STM32 internal temperature sensor via ADC1_IN16
 */
static float HAL_Read_Mcu_Temperature(void) {
    return 38.5f; /* 38.5 °C */
}

/**
 * @brief Hardware Tick Timer in Milliseconds
 */
static uint32_t HAL_Get_Tick_Ms(void) {
    /* return HAL_GetTick(); or xTaskGetTickCount() * portTICK_PERIOD_MS; */
    return 310792;
}

/* ========================================================================= */
/*                          MODULE IMPLEMENTATION                            */
/* ========================================================================= */

void DeviceHealth_Init(const char *thing_name) {
    if (thing_name && strlen(thing_name) > 0) {
        strncpy(g_thing_name, thing_name, sizeof(g_thing_name) - 1);
        g_thing_name[sizeof(g_thing_name) - 1] = '\0';
    }
    printf("[HEALTH CHECK INIT] Initialized for thingName: %s\r\n", g_thing_name);
}

bool DeviceHealth_SubscribeTopic(void) {
    char sub_topic[128];
    snprintf(sub_topic, sizeof(sub_topic), "lc-gate/%s/health/request", g_thing_name);

    printf("[MQTT SUBSCRIBE] Topic: %s (QoS 1)\r\n", sub_topic);

    /*
     * --- SIM7600G AT Command MQTT Subscribe ---
     * 1. AT+CMQTTSUB=0,<topic_len>,1
     * 2. Send: lc-gate/<thingName>/health/request
     * 
     * In production:
     * int status = SIM7600_MQTT_Subscribe(sub_topic, 1);
     * return (status == 0);
     */
    return true;
}

void DeviceHealth_SampleHardware(const char *request_id, DeviceHealthReport_t *report) {
    if (!report) return;
    memset(report, 0, sizeof(DeviceHealthReport_t));

    strncpy(report->master_device_id, g_thing_name, sizeof(report->master_device_id) - 1);
    if (request_id && strlen(request_id) > 0) {
        strncpy(report->request_id, request_id, sizeof(report->request_id) - 1);
    } else {
        snprintf(report->request_id, sizeof(report->request_id), "diag_%lu", HAL_Get_Tick_Ms());
    }

    strncpy(report->action, "HEALTH_CHECK_RESPONSE", sizeof(report->action) - 1);

    /* 1. Power measurements */
    report->battery_voltage = HAL_Read_Battery_Voltage();
    report->battery_percentage = HAL_Compute_Battery_Percentage(report->battery_voltage);
    report->solar_voltage = HAL_Read_Solar_Voltage();
    report->solar_charging = (report->solar_voltage > (report->battery_voltage + 0.5f));

    /* 2. Cellular Modem Diagnostics */
    report->signal_strength_csq = HAL_Read_Modem_CSQ();
    strncpy(report->network_type, "4G_LTE", sizeof(report->network_type) - 1);
    strncpy(report->imei, "864205041234567", sizeof(report->imei) - 1);

    /* 3. Sensor States */
    report->limit_switch_closed = HAL_Read_Limit_Switch();
    report->hall_closed = HAL_Read_Hall_Effect();
    report->boom_angle_deg = HAL_Read_Boom_Angle();

    if (report->limit_switch_closed && report->hall_closed) {
        strncpy(report->gate_status, "CLOSED", sizeof(report->gate_status) - 1);
    } else {
        strncpy(report->gate_status, "NOT_CLOSED", sizeof(report->gate_status) - 1);
    }

    /* 4. MCU System Diagnostics */
    report->mcu_temperature_c = HAL_Read_Mcu_Temperature();
    report->uptime_seconds = HAL_Get_Tick_Ms() / 1000;
    report->timestamp_ms = HAL_Get_Tick_Ms();
    strncpy(report->firmware_version, "1.0.2", sizeof(report->firmware_version) - 1);

    /* 5. Health Verdict Decision Matrix */
    if (report->battery_voltage < 11.5f || report->signal_strength_csq < 5) {
        strncpy(report->status, "DEGRADED", sizeof(report->status) - 1);
    } else {
        strncpy(report->status, "HEALTHY", sizeof(report->status) - 1);
    }
}

int DeviceHealth_SerializeJson(const DeviceHealthReport_t *r, char *buf, size_t max_len) {
    if (!r || !buf || max_len < 512) return -1;

    int written = snprintf(buf, max_len,
        "{"
        "\"action\":\"%s\","
        "\"MasterDeviceId\":\"%s\","
        "\"requestId\":\"%s\","
        "\"status\":\"%s\","
        "\"Status\":\"%s\","
        "\"BatteryVoltage\":%.2f,"
        "\"BatteryPercentage\":%u,"
        "\"SolarVoltage\":%.2f,"
        "\"SolarCharging\":%s,"
        "\"SignalStrength\":%d,"
        "\"NetworkType\":\"%s\","
        "\"LimitSwitchClosed\":%s,"
        "\"HallClosed\":%s,"
        "\"BoomAngle\":%.1f,"
        "\"McuTempC\":%.1f,"
        "\"UptimeSeconds\":%lu,"
        "\"TimeStampMs\":%lu,"
        "\"FirmwareVersion\":\"%s\""
        "}",
        r->action,
        r->master_device_id,
        r->request_id,
        r->status,
        r->gate_status,
        r->battery_voltage,
        r->battery_percentage,
        r->solar_voltage,
        r->solar_charging ? "true" : "false",
        r->signal_strength_csq,
        r->network_type,
        r->limit_switch_closed ? "true" : "false",
        r->hall_closed ? "true" : "false",
        r->boom_angle_deg,
        r->mcu_temperature_c,
        (unsigned long)r->uptime_seconds,
        (unsigned long)r->timestamp_ms,
        r->firmware_version
    );

    return written;
}

bool DeviceHealth_PublishReport(const char *request_id) {
    DeviceHealthReport_t report;
    DeviceHealth_SampleHardware(request_id, &report);

    static char payload_buffer[1024];
    int json_len = DeviceHealth_SerializeJson(&report, payload_buffer, sizeof(payload_buffer));
    if (json_len <= 0) {
        printf("[ERROR] Failed to serialize health report\r\n");
        return false;
    }

    char pub_topic[128];
    snprintf(pub_topic, sizeof(pub_topic), "lc-gate/%s/health", g_thing_name);

    printf("[MQTT PUBLISH RESPONSE] Topic: %s (Bytes: %d)\r\n", pub_topic, json_len);
    printf("[HEALTH PAYLOAD]: %s\r\n", payload_buffer);

    /*
     * --- SIM7600G AT Command MQTT Publish ---
     * 1. AT+CMQTTTOPIC=0,<topic_len>
     * 2. Send: lc-gate/<thingName>/health
     * 3. AT+CMQTTPAYLOAD=0,<payload_len>
     * 4. Send payload_buffer
     * 5. AT+CMQTTPUB=0,1,60
     * 
     * In production:
     * return (SIM7600_MQTT_Publish(pub_topic, payload_buffer, json_len, 1) == 0);
     */
    return true;
}

bool DeviceHealth_ProcessIncomingCommand(const char *topic, const char *payload, size_t len) {
    if (!topic || !payload) return false;

    printf("[MQTT INBOUND COMMAND] Topic: %s (Len: %zu)\r\n", topic, len);
    printf("[INBOUND PAYLOAD]: %s\r\n", payload);

    /* Quick parse of requestId from incoming JSON */
    char req_id[64] = "hc_default";
    const char *key = "\"requestId\":\"";
    char *match = strstr(payload, key);
    if (match) {
        match += strlen(key);
        char *end = strchr(match, '\"');
        if (end) {
            size_t id_len = end - match;
            if (id_len < sizeof(req_id)) {
                strncpy(req_id, match, id_len);
                req_id[id_len] = '\0';
            }
        }
    }

    /* Check action */
    if (strstr(payload, "HEALTH_CHECK")) {
        printf("[HEALTH CHECK TRIGGERED] Responding to requestId: %s\r\n", req_id);
        return DeviceHealth_PublishReport(req_id);
    }

    return false;
}
