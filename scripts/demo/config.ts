/** Where the demo dashboard runs. Its own module, so shoot.ts does not start the demo. */
export const PORT = Number(process.env.DEMO_PORT ?? 7790);
export const ROOT = "/tmp/agent-dash-demo";
