/*
 * Voxel Multiplayer Hills v4.1.0 deployment configuration.
 *
 * Public deployment uses the Render-hosted WebSocket relay below.
 * Local development automatically uses ws://localhost:8131/ws.
 */
window.VOXEL_CONFIG = Object.freeze({
  VERSION: '4.1.0',
  PUBLIC_WEBSOCKET_URL: 'wss://voxel-multiplayer-hills-410-server.onrender.com/ws',
  LOCAL_WEBSOCKET_URL: 'ws://localhost:8131/ws'
});
