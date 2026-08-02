/*
 * Voxel Multiplayer Hills v4.1.0 deployment configuration.
 *
 * After deploying /server to Render, replace the placeholder below with the
 * service's public WebSocket URL, including /ws. Example:
 *
 *   PUBLIC_WEBSOCKET_URL: 'wss://voxel-hills-server.onrender.com/ws'
 *
 * Local development automatically uses ws://localhost:8131/ws.
 */
window.VOXEL_CONFIG = Object.freeze({
  VERSION: '4.1.0',
  PUBLIC_WEBSOCKET_URL: 'wss://YOUR-RENDER-SERVICE.onrender.com/ws',
  LOCAL_WEBSOCKET_URL: 'ws://localhost:8131/ws'
});
