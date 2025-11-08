const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT = process.env.PORT || 3000;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.roomId = null;
    this.playerRole = null;

    this.remoteAddress = socket.remoteAddress;
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => this.emit('close'));
    socket.on('error', (error) => this.emit('error', error));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) === 0x80;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        payloadLength = high * 2 ** 32 + low;
        offset += 8;
      }

      let maskingKey;
      if (isMasked) {
        if (this.buffer.length < offset + 4) return;
        maskingKey = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLength) return;

      const payload = this.buffer.slice(offset, offset + payloadLength);
      this.buffer = this.buffer.slice(offset + payloadLength);

      if (isMasked && maskingKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskingKey[i % 4];
        }
      }

      if (opcode === 0x8) {
        this.close();
        return;
      }

      if (opcode === 0x9) {
        this.sendFrame(payload, 0xA);
        continue;
      }

      if (opcode !== 0x1) {
        continue;
      }

      this.emit('message', payload.toString('utf8'));
    }
  }

  sendFrame(data, opcode = 0x1) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const payloadLength = payload.length;
    let headerLength = 2;

    if (payloadLength >= 126 && payloadLength < 65536) {
      headerLength += 2;
    } else if (payloadLength >= 65536) {
      headerLength += 8;
    }

    const frame = Buffer.alloc(headerLength + payloadLength);
    frame[0] = 0x80 | opcode;

    if (payloadLength < 126) {
      frame[1] = payloadLength;
      payload.copy(frame, 2);
    } else if (payloadLength < 65536) {
      frame[1] = 126;
      frame.writeUInt16BE(payloadLength, 2);
      payload.copy(frame, 4);
    } else {
      frame[1] = 127;
      const high = Math.floor(payloadLength / 2 ** 32);
      const low = payloadLength >>> 0;
      frame.writeUInt32BE(high, 2);
      frame.writeUInt32BE(low, 6);
      payload.copy(frame, 10);
    }

    this.socket.write(frame);
  }

  sendJSON(payload) {
    try {
      this.sendFrame(JSON.stringify(payload));
    } catch (error) {
      console.error('Failed to send payload', error);
    }
  }

  close() {
    try {
      this.socket.end();
    } catch (error) {
      console.error('Failed to close connection', error);
    }
  }
}

function createRoomId() {
  let roomId;
  do {
    roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(roomId));
  return roomId;
}

function sendError(connection, message) {
  connection.sendJSON({ type: 'error', message });
}

function getRoom(connection) {
  if (!connection.roomId) return null;
  return rooms.get(connection.roomId) || null;
}

function getOpponent(connection) {
  const room = getRoom(connection);
  if (!room) return null;
  if (room.host === connection) return room.guest;
  if (room.guest === connection) return room.host;
  return null;
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
}

function leaveRoom(connection, { notifyOpponent = true } = {}) {
  if (!connection.roomId) return;
  const { roomId } = connection;
  const room = rooms.get(roomId);

  if (room) {
    if (room.host === connection) {
      room.host = null;
    } else if (room.guest === connection) {
      room.guest = null;
    }

    const opponent = room.host || room.guest;
    if (!room.host && !room.guest) {
      cleanupRoom(roomId);
    } else if (notifyOpponent && opponent) {
      opponent.sendJSON({ type: 'opponentLeft' });
      leaveRoom(opponent, { notifyOpponent: false });
      cleanupRoom(roomId);
    }
  }

  connection.roomId = null;
  connection.playerRole = null;
}

function handleCreateRoom(connection) {
  leaveRoom(connection);
  const roomId = createRoomId();

  rooms.set(roomId, { id: roomId, host: connection, guest: null });
  connection.roomId = roomId;
  connection.playerRole = 'left';

  log(`[room] Created ${roomId} for ${connection.remoteAddress || 'unknown'}`);
  connection.sendJSON({ type: 'roomCreated', roomId, role: 'left' });
}

function handleJoinRoom(connection, providedRoomId) {
  if (!providedRoomId) {
    sendError(connection, 'Room id is required.');
    return;
  }

  const roomId = String(providedRoomId).trim().toUpperCase();
  const room = rooms.get(roomId);

  if (!room) {
    sendError(connection, 'Room not found.');
    return;
  }

  if (!room.host) {
    cleanupRoom(roomId);
    sendError(connection, 'Room is not available. Ask the host to create a new one.');
    return;
  }

  if (room.guest) {
    sendError(connection, 'Room is full.');
    return;
  }

  if (room.host === connection) {
    sendError(connection, 'You are already hosting this room.');
    return;
  }

  leaveRoom(connection);
  room.guest = connection;
  connection.roomId = roomId;
  connection.playerRole = 'right';

  log(`[room] ${connection.remoteAddress || 'unknown'} joined room ${roomId}`);
  connection.sendJSON({ type: 'roomJoined', roomId, role: 'right' });
  room.host.sendJSON({ type: 'playerJoined', roomId });

  room.host.sendJSON({ type: 'roomReady', roomId });
  room.guest.sendJSON({ type: 'roomReady', roomId });
}

function handlePaddleMove(connection, payload) {
  const room = getRoom(connection);
  if (!room) return;

  const opponent = getOpponent(connection);
  if (!opponent) return;

  const y = typeof payload.y === 'number' ? payload.y : null;
  if (y === null || Number.isNaN(y)) return;

  opponent.sendJSON({
    type: 'opponentMove',
    role: connection.playerRole,
    y,
  });
}

function handleStateUpdate(connection, payload) {
  const room = getRoom(connection);
  if (!room) return;
  if (room.host !== connection) return;
  if (!room.guest) return;

  if (typeof payload !== 'object' || payload === null) return;
  room.guest.sendJSON({ type: 'stateUpdate', state: payload });
}

function handleMessage(connection, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch (error) {
    sendError(connection, 'Invalid JSON payload.');
    return;
  }

  switch (message.type) {
    case 'createRoom':
      log(`[ws] createRoom from ${connection.remoteAddress || 'unknown'}`);
      handleCreateRoom(connection);
      break;
    case 'joinRoom':
      log(
        `[ws] joinRoom ${message.roomId || 'N/A'} from ${
          connection.remoteAddress || 'unknown'
        }`,
      );
      handleJoinRoom(connection, message.roomId);
      break;
    case 'paddleMove':
      handlePaddleMove(connection, message);
      break;
    case 'stateUpdate':
      log(`[ws] stateUpdate from ${connection.remoteAddress || 'unknown'}`);
      handleStateUpdate(connection, message.state);
      break;
    default:
      sendError(connection, `Unknown message type: ${message.type}`);
  }
}

function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
  ];

  socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  const connection = new WebSocketConnection(socket);
  log(`[ws] client connected ${connection.remoteAddress || 'unknown'}`);

  connection.on('message', (data) => handleMessage(connection, data));
  connection.on('close', () => {
    log(`[ws] client disconnected ${connection.remoteAddress || 'unknown'}`);
    leaveRoom(connection);
  });
  connection.on('error', (error) => {
    log(
      `[ws] client error ${connection.remoteAddress || 'unknown'}: ${
        error?.message || error
      }`,
    );
    leaveRoom(connection);
  });

  if (head && head.length) {
    connection.handleData(head);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Pong multiplayer WebSocket server is running.\n');
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    log(
      `[ws] upgrade request from ${req.socket.remoteAddress || 'unknown'} ${
        req.headers.origin || ''
      }`,
    );
    acceptWebSocket(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  log(`WebSocket server listening on ws://localhost:${PORT}`);
});
