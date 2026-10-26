/**
 * @file device_config.h
 * @brief LC-Platform Device Hardware & Sensor Manifest Definition
 * 
 * Target Architecture: STM32F4xx / FreeRTOS / SIM7600G-H LTE Modem
 * This header defines the exact device configuration struct and JSON schema
 * transmitted to LC-Platform during boot / commissioning.
 */

#ifndef DEVICE_CONFIG_H
#define DEVICE_CONFIG_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ========================================================================= */
/*                          1. SYSTEM CONSTANTS                              */
/* ========================================================================= */

#define MAX_SENSORS_COUNT       12
#define MAX_COMPONENTS_COUNT    10
#define STR_LEN_SHORT           32
#define STR_LEN_MID             64
#define STR_LEN_LONG            128

/* ========================================================================= */
/*                          2. DATA STRUCTURES                               */
/* ========================================================================= */

/**
 * @brief Internal Sensor Definition Structure
 */
typedef struct {
    char id[STR_LEN_SHORT];          /* Unique sensor ID (e.g. "solar_volt") */
    char name[STR_LEN_MID];          /* Display name (e.g. "Solar Panel Voltage Monitor") */
    char type[STR_LEN_SHORT];        /* Type: VOLTAGE_ADC, CURRENT_SHUNT, INCLINOMETER, RADAR, TEMP */
    char bus_interface[STR_LEN_SHORT];/* Hardware interface: ADC1, I2C1, SPI2, USART2, GPIO */
    char pin_or_address[STR_LEN_SHORT];/* Pin: "PA0" or I2C Addr: "0x40" */
    char unit[16];                   /* Measurement unit: "V", "A", "deg", "C", "km/h" */
    char range[STR_LEN_SHORT];       /* Operating range: "0-30V", "-30A to +30A", "0-90 deg" */
    float calibration_factor;        /* Voltage divider or ADC multiplier (e.g. 11.0f) */
} SensorConfig_t;

/**
 * @brief Internal Embedded Component Definition Structure
 */
typedef struct {
    char name[STR_LEN_MID];          /* Component name: "Microcontroller", "Cellular Modem" */
    char model[STR_LEN_MID];         /* Model: "STM32F401 Blackpill", "SIM7600G-H" */
    char spec[STR_LEN_LONG];         /* Specs: "ARM Cortex-M4 84MHz, 256KB Flash" */
    char vendor[STR_LEN_SHORT];      /* Vendor: "STMicroelectronics", "SIMCom" */
} ComponentConfig_t;

/**
 * @brief Manufacturing Metadata Structure (Usually stored in Flash EEPROM / OTP)
 */
typedef struct {
    char manufacturer[STR_LEN_MID];  /* e.g. "Mirtha / LC-Platform" */
    char model_number[STR_LEN_MID];  /* e.g. "LC-GATE-MASTER-V2" */
    char batch_number[STR_LEN_SHORT];/* e.g. "BATCH-2024-Q3" */
    char date_of_mfg[STR_LEN_SHORT]; /* ISO-8601 date: "2024-05-15" */
} ManufacturingInfo_t;

/**
 * @brief Hardware Specification Structure
 */
typedef struct {
    char hardware_version[STR_LEN_SHORT]; /* e.g. "rev2.1" */
    char mcu[STR_LEN_MID];                /* e.g. "STM32F401RET6" */
    char modem[STR_LEN_MID];              /* e.g. "SIM7600G-H LTE CAT-4" */
    char imei[STR_LEN_SHORT];             /* Cellular IMEI read at boot: "864205041234567" */
    char mac_address[STR_LEN_SHORT];      /* Optional MAC: "A4:CF:12:89:BC:44" */
} HardwareInfo_t;

/**
 * @brief Firmware Specification Structure
 */
typedef struct {
    char version[STR_LEN_SHORT];     /* e.g. "v2.1.4" */
    char build_date[STR_LEN_SHORT];  /* e.g. "2024-10-20T10:00:00Z" */
    char git_commit[16];             /* e.g. "a3f8c9b" */
    char bootloader_version[16];     /* e.g. "v1.0.2" */
} FirmwareInfo_t;

/**
 * @brief Runtime Config Parameters
 */
typedef struct {
    uint16_t telemetry_interval_sec;  /* Telemetry cadence: default 10s */
    uint16_t heartbeat_interval_sec;  /* Ping cadence: default 60s */
    float battery_low_threshold_v;    /* Low voltage alert: default 11.8V */
    float solar_cutin_voltage_v;      /* Solar cut-in threshold: default 13.2V */
} RuntimeConfig_t;

/**
 * @brief Complete Root Device Configuration Manifest
 */
typedef struct {
    char thing_name[STR_LEN_SHORT];   /* AWS IoT Thing Name (e.g. "LC-0001-01") */
    char serial_number[STR_LEN_SHORT];/* Device Serial Number (e.g. "LC-0001-01") */
    char device_type[16];             /* "MASTER" or "SLAVE" */

    HardwareInfo_t hardware;
    FirmwareInfo_t firmware;
    ManufacturingInfo_t manufacturing;
    RuntimeConfig_t runtime_config;

    uint8_t sensors_count;
    SensorConfig_t sensors[MAX_SENSORS_COUNT];

    uint8_t components_count;
    ComponentConfig_t components[MAX_COMPONENTS_COUNT];
} DeviceManifest_t;

/* ========================================================================= */
/*                          3. FUNCTION DECLARATIONS                         */
/* ========================================================================= */

/**
 * @brief Populates the DeviceManifest struct with hardware constants,
 *        reads IMEI from SIM7600G modem, and loads calibration from Flash.
 */
void DeviceConfig_Init(DeviceManifest_t *manifest);

/**
 * @brief Serializes the DeviceManifest into a JSON string buffer.
 * @param manifest Pointer to populated manifest
 * @param json_buffer Destination char buffer
 * @param buffer_size Size of destination buffer (recommended >= 2048 bytes)
 * @return int Length of serialized JSON, or -1 on error
 */
int DeviceConfig_SerializeJson(const DeviceManifest_t *manifest, char *json_buffer, size_t buffer_size);

/**
 * @brief Publishes the serialized manifest to AWS IoT Core MQTT topic:
 *        `lc/devices/<thingName>/manifest`
 * @return bool true on successful transmission
 */
bool DeviceConfig_PublishToCloud(const DeviceManifest_t *manifest);

#ifdef __cplusplus
}
#endif

#endif /* DEVICE_CONFIG_H */
