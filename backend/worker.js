console.log('Worker Process starting...');
// Logic to consume SQS messages and process AWS IoT events
// Also handles alert timer polling.

setInterval(() => {
    console.log('[Worker] Polling SQS for messages / timer polling...');
}, 5000);
