# pong

## Multiplayer setup

1. Start the WebSocket relay:
   ```bash
   node server.js
   ```
2. Open `multiplayer.html` in two separate browser windows (or serve it statically and share the link).
3. Click **Create Room** in one window, copy the generated URL, and open it in the second window (or enter the room ID and press **Join Room**).
4. Each player can move their paddle with either the `W/S` keys or the `Arrow Up/Down` keys—pick whatever feels comfortable. Wait for the lobby overlay to confirm both players are connected before rallying.

The single-player AI modes remain available via the other HTML files at the project root.
