import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

let iotClient: IoTDataPlaneClient | null = null;

function getIoTClient(): IoTDataPlaneClient | null {
  const endpoint = process.env.AWS_IOT_ENDPOINT;
  const region = process.env.AWS_REGION || 'ap-south-1';

  if (!endpoint) {
    return null;
  }

  if (!iotClient) {
    iotClient = new IoTDataPlaneClient({
      endpoint: endpoint.startsWith('https://') ? endpoint : `https://${endpoint}`,
      region,
      credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      } : undefined,
    });
  }

  return iotClient;
}

/**
 * Publishes an MQTT message to AWS IoT Core broker
 */
export async function publishMqttMessage(topic: string, payload: any): Promise<{ success: boolean; error?: string }> {
  try {
    const client = getIoTClient();
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

    if (!client) {
      console.warn(`[AWS IoT MQTT] AWS_IOT_ENDPOINT not configured in environment. Topic: ${topic}. Payload: ${payloadStr}`);
      return {
        success: false,
        error: 'AWS_IOT_ENDPOINT not configured in backend environment',
      };
    }

    const command = new PublishCommand({
      topic,
      payload: Buffer.from(payloadStr),
      qos: 1,
    });

    await client.send(command);
    console.log(`[AWS IoT MQTT] Published message successfully to topic: ${topic}`);
    return { success: true };
  } catch (err: any) {
    console.error(`[AWS IoT MQTT Publish Error] Topic: ${topic}:`, err);
    return { success: false, error: err.message };
  }
}
