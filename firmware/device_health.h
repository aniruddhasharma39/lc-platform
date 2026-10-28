/**
 * @file device_health.h
 * @brief On-Demand Health Diagnostic Handler for LC-Platform Edge Device
 * 
 * Target Architecture: STM32F4xx / FreeRTOS / SIM7600G-H LTE Modem
 * 
 * Workflow:
 * 1. Firmware subscribes to: `lc-gate/<thingName>/health/request`
 * 2. When AWS IoT forwards a test command from the web app, this module:
 *    - Reads Battery Voltage & BMS status (ADC1/I2C)
 *    - Reads Solar Panel Voltage (ADC1)
 *    - Queries SIM7600G for Cellular Signal Quality (AT+CSQ)
 *    - Samples Limit Switch GPIO (PE2) & Hall Effect Sensor (PE3)
 *    - Reads Inclinometer Boom Angle (I2C1 MPU-6050/LIS3DH)
 *    - Reads MCU internal temperature
 * 3. Builds and publishes a diagnostic report to: `lc-gate/<thingName>/health`
 */

#ifndef DEVICE_HEALTH_H
#define DEVICE_HEALTH_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ========================================================================= */
/*                          STRUCTURE DEFINITIONS                            */
/* ========================================================================= */

/**
 * @brief Inbound Health Check Command Request Payload
 */
typedef struct {
    char action[32];            /* "HEALTH_CHECK" */
    char master_device_id[32];  /* e.g. "LC-M-001" */
    char request_id[64];        /* e.g. "hc_1730104829102" */
    char timestamp[32];         /* ISO-8601 string */
} DeviceHealthRequest_t;

/**
 * @brief Outbound Comprehensive Diagnostic Report
 */
typedef struct {
    char master_device_id[32];  /* e.g. "LC-M-001" */
    char request_id[64];        /* Echoed from request */
    char action[32];            /* "HEALTH_CHECK_RESPONSE" */
    char status[16];            /* "HEALTHY", "DEGRADED", "FAULT" */

    /* Power System */
    float battery_voltage;      /* e.g. 12.65 V */
    uint8_t battery_percentage; /* 0 - 100% */
    float solar_voltage;        /* e.g. 18.40 V */
    bool solar_charging;        /* true if solar > battery */

    /* Cellular Modem Diagnostics (SIM7600) */
    int8_t signal_strength_csq; /* 0-31 CSQ (99 = unknown) */
    char network_type[16];      /* "4G_LTE", "2G_GPRS" */
    char imei[20];              /* Modem IMEI */

    /* Gate Barrier Sensors */
    bool limit_switch_closed;   /* true = Closed, false = Open */
    bool hall_closed;           /* true = Closed, false = Open */
    float boom_angle_deg;       /* 0.0 to 90.0 degrees */
    char gate_status[16];       /* "CLOSED" or "NOT_CLOSED" */

    /* System Controller Diagnostics */
    float mcu_temperature_c;    /* Internal STM32 temp (e.g. 38.5 C) */
    uint32_t uptime_seconds;    /* Seconds elapsed since MCU boot */
    uint32_t timestamp_ms;      /* FreeRTOS tick ms */
    char firmware_version[16];  /* e.g. "1.0.2" */
} DeviceHealthReport_t;

/* ========================================================================= */
/*                          FUNCTION DECLARATIONS                            */
/* ========================================================================= */

/**
 * @brief Initializes the Device Health module, registers MQTT callback.
 * @param thing_name Device thing name (e.g. "LC-M-001")
 */
void DeviceHealth_Init(const char *thing_name);

/**
 * @brief Subscribes modem to the health request topic:
 *        `lc-gate/<thingName>/health/request`
 * @return bool true if MQTT subscription succeeded
 */
bool DeviceHealth_SubscribeTopic(void);

/**
 * @brief Callback triggered when an MQTT message arrives on the subscribed topic.
 * @param topic The MQTT topic string
 * @param payload Raw payload string
 * @param len Length of the payload
 * @return bool true if successfully processed and responded
 */
bool DeviceHealth_ProcessIncomingCommand(const char *topic, const char *payload, size_t len);

/**
 * @brief Samples all physical hardware sensors and fills the report struct.
 * @param request_id The tracking ID from the cloud request
 * @param report Output pointer to populate
 */
void DeviceHealth_SampleHardware(const char *request_id, DeviceHealthReport_t *report);

/**
 * @brief Serializes the diagnostic report into JSON.
 * @param report Input populated report
 * @param buf Output char buffer
 * @param max_len Buffer size (recommend >= 1024 bytes)
 * @return int Length written or -1 on error
 */
int DeviceHealth_SerializeJson(const DeviceHealthReport_t *report, char *buf, size_t max_len);

/**
 * @brief Samples hardware and publishes the health response to:
 *        `lc-gate/<thingName>/health`
 * @param request_id Request ID received from cloud command
 * @return bool true if successfully published
 */
bool DeviceHealth_PublishReport(const char *request_id);

#ifdef __cplusplus
}
#endif

#endif /* DEVICE_HEALTH_H */
