const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT = process.env.PORT || 3000;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const SIM_TICK_RATE = 120;
const STATE_BROADCAST_RATE = 60;
const SIM_DT = 1 / SIM_TICK_RATE;
const BROADCAST_INTERVAL = Math.max(1, Math.round(SIM_TICK_RATE / STATE_BROADCAST_RATE));
const HISTORY_SIZE = 600;

const GAME_CONFIG = {
  width: 800,
  height: 400,
  paddleWidth: 10,
  paddleHeight: 60,
  paddleMargin: 20,
  ballSize: 10,
  paddleSpeed: 420, // px per second
  baseBallSpeedX: 280,
  baseBallSpeedY: 200,
  accelerationFactor: 1.04,
  scoreLimit: 11,
};

const rooms = new Map();

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.id = crypto.randomBytes(8).toString('hex');
    this.roomId = null;
    this.playerRole = null;
    this.reliableQueue = [];
    this.unreliableQueue = [];
    this.flushScheduled = false;
    this.destroyed = false;
    this.MAX_RELIABLE_BATCH = 8;
    this.MAX_UNRELIABLE_BATCH = 4;

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

      if (opcode !== 0x1) continue;

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

  sendJSON(payload, options = {}) {
    this.enqueuePayload(payload, options);
  }

  enqueuePayload(payload, { reliable = true } = {}) {
    if (this.destroyed) return;
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      console.error('Failed to serialize payload', error);
      return;
    }
    if (reliable) {
      this.reliableQueue.push(serialized);
    } else {
      this.unreliableQueue.push(serialized);
    }
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushScheduled || this.destroyed) return;
    this.flushScheduled = true;
    setImmediate(() => this.flushQueues());
  }

  flushQueues() {
    if (this.destroyed) {
      this.reliableQueue.length = 0;
      this.unreliableQueue.length = 0;
      return;
    }
    this.flushScheduled = false;
    let sentReliable = 0;
    let sentUnreliable = 0;
    while (this.unreliableQueue.length && sentUnreliable < this.MAX_UNRELIABLE_BATCH) {
      const payload = this.unreliableQueue.shift();
      this.sendFrame(payload);
      sentUnreliable += 1;
    }
    while (this.reliableQueue.length && sentReliable < this.MAX_RELIABLE_BATCH) {
      const payload = this.reliableQueue.shift();
      this.sendFrame(payload);
      sentReliable += 1;
    }
    if (this.reliableQueue.length || this.unreliableQueue.length) {
      this.scheduleFlush();
    }
  }

  clearQueues() {
    this.reliableQueue.length = 0;
    this.unreliableQueue.length = 0;
    this.flushScheduled = false;
  }

  close() {
    try {
      this.socket.end();
    } catch (error) {
      console.error('Failed to close connection', error);
    }
    this.destroyed = true;
    this.clearQueues();
  }
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function createRoomId() {
  let roomId;
  do {
    roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(roomId));
  return roomId;
}

function defaultInputPacket() {
  return { frame: 0, up: false, down: false };
}

function createInitialState() {
  const ballX = GAME_CONFIG.width / 2 - GAME_CONFIG.ballSize / 2;
  const ballY = GAME_CONFIG.height / 2 - GAME_CONFIG.ballSize / 2;
  const serveDir = Math.random() > 0.5 ? 1 : -1;
  return {
    frame: 0,
    ballX,
    ballY,
    ballVX: GAME_CONFIG.baseBallSpeedX * serveDir,
    ballVY: GAME_CONFIG.baseBallSpeedY * (Math.random() > 0.5 ? 1 : -1),
    leftY: GAME_CONFIG.height / 2 - GAME_CONFIG.paddleHeight / 2,
    rightY: GAME_CONFIG.height / 2 - GAME_CONFIG.paddleHeight / 2,
    leftScore: 0,
    rightScore: 0,
    serving: serveDir > 0 ? 'right' : 'left',
    gameOver: false,
    winner: null,
  };
}

function createRoom() {
  const roomId = createRoomId();
  const room = {
    id: roomId,
    players: { left: null, right: null },
    inputs: { left: defaultInputPacket(), right: defaultInputPacket() },
    started: false,
    state: createInitialState(),
    lastBroadcastFrame: 0,
    sequence: 0,
    history: [],
  };
  rooms.set(roomId, room);
  return room;
}

function getRoom(connection) {
  if (!connection.roomId) return null;
  return rooms.get(connection.roomId) || null;
}

function leaveRoom(connection) {
  const room = getRoom(connection);
  if (!room) return;

  if (room.players.left === connection) {
    room.players.left = null;
  } else if (room.players.right === connection) {
    room.players.right = null;
  }

  connection.roomId = null;
  connection.playerRole = null;

  const remainingPlayer = room.players.left || room.players.right;
  if (!remainingPlayer) {
    rooms.delete(room.id);
    return;
  }

  remainingPlayer.sendJSON({ channel: 'control', type: 'opponentLeft' }, { reliable: true });
  room.started = false;
}

function handleCreateRoom(connection) {
  leaveRoom(connection);

  const room = createRoom();

  room.players.left = connection;
  connection.roomId = room.id;
  connection.playerRole = 'left';

  connection.sendJSON({ channel: 'control', type: 'roomCreated', roomId: room.id, role: 'left' }, { reliable: true });
}

function handleJoinRoom(connection, providedRoomId) {
  if (!providedRoomId) {
    connection.sendJSON({ channel: 'control', type: 'error', message: 'Room id is required.' }, { reliable: true });
    return;
  }

  const roomId = String(providedRoomId).trim().toUpperCase();
  const room = rooms.get(roomId);

  if (!room || !room.players.left) {
    connection.sendJSON({ channel: 'control', type: 'error', message: 'Room not found or unavailable.' }, { reliable: true });
    return;
  }

  if (room.players.right) {
    connection.sendJSON({ channel: 'control', type: 'error', message: 'Room is full.' }, { reliable: true });
    return;
  }

  leaveRoom(connection);
  room.players.right = connection;
  connection.roomId = room.id;
  connection.playerRole = 'right';

  connection.sendJSON({ channel: 'control', type: 'roomJoined', roomId: room.id, role: 'right' }, { reliable: true });
  room.players.left.sendJSON({ channel: 'control', type: 'playerJoined', roomId: room.id }, { reliable: true });

  startMatch(room);
}

function startMatch(room) {
  room.state = createInitialState();
  room.inputs.left = defaultInputPacket();
  room.inputs.right = defaultInputPacket();
  room.started = true;
  room.sequence = 0;
  room.history = [];

  const payload = {
    channel: 'control',
    type: 'matchStart',
    roomId: room.id,
    state: serializeState(room),
  };

  Object.values(room.players).forEach((player) => {
    if (player) player.sendJSON(payload, { reliable: true });
  });
}

function handlePlayerInput(connection, message) {
  const room = getRoom(connection);
  if (!room || !connection.playerRole) return;

  const packet = room.inputs[connection.playerRole];
  if (!packet) return;

  const frame = typeof message.frame === 'number' ? message.frame : 0;
  const up = Boolean(message.up);
  const down = Boolean(message.down);

  if (frame >= packet.frame) {
    packet.frame = frame;
    packet.up = up;
    packet.down = down;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getAxis(input) {
  if (input.up && !input.down) return -1;
  if (input.down && !input.up) return 1;
  return 0;
}

function reflectBall(state, paddleY) {
  const paddleCenter = paddleY + GAME_CONFIG.paddleHeight / 2;
  const ballCenter = state.ballY + GAME_CONFIG.ballSize / 2;
  const offset = (ballCenter - paddleCenter) / (GAME_CONFIG.paddleHeight / 2);
  const deflection = offset * 220;
  state.ballVY = clamp(
    state.ballVY * GAME_CONFIG.accelerationFactor + deflection,
    -500,
    500,
  );
  state.ballVX *= GAME_CONFIG.accelerationFactor;
}

function resetBall(state, scorer) {
  state.ballX = GAME_CONFIG.width / 2 - GAME_CONFIG.ballSize / 2;
  state.ballY = GAME_CONFIG.height / 2 - GAME_CONFIG.ballSize / 2;
  state.ballVX = GAME_CONFIG.baseBallSpeedX * (scorer === 'left' ? 1 : -1);
  state.ballVY = GAME_CONFIG.baseBallSpeedY * (Math.random() > 0.5 ? 1 : -1);
  state.serving = scorer;
}

function simulateRoom(room) {
  if (!room.started || !room.players.left || !room.players.right) return;
  const state = room.state;

  state.frame += 1;

  const leftAxis = getAxis(room.inputs.left);
  const rightAxis = getAxis(room.inputs.right);

  state.leftY += leftAxis * GAME_CONFIG.paddleSpeed * SIM_DT;
  state.rightY += rightAxis * GAME_CONFIG.paddleSpeed * SIM_DT;

  const paddleLimit = GAME_CONFIG.height - GAME_CONFIG.paddleHeight;
  state.leftY = clamp(state.leftY, 0, paddleLimit);
  state.rightY = clamp(state.rightY, 0, paddleLimit);

  let nextBallX = state.ballX + state.ballVX * SIM_DT;
  let nextBallY = state.ballY + state.ballVY * SIM_DT;

  if (nextBallY <= 0) {
    nextBallY = 0;
    state.ballVY = Math.abs(state.ballVY);
  } else if (nextBallY + GAME_CONFIG.ballSize >= GAME_CONFIG.height) {
    nextBallY = GAME_CONFIG.height - GAME_CONFIG.ballSize;
    state.ballVY = -Math.abs(state.ballVY);
  }

  const rightPaddleX = GAME_CONFIG.width - GAME_CONFIG.paddleMargin - GAME_CONFIG.paddleWidth;
  if (
    state.ballVX > 0 &&
    nextBallX + GAME_CONFIG.ballSize >= rightPaddleX &&
    nextBallX <= rightPaddleX + GAME_CONFIG.paddleWidth &&
    nextBallY + GAME_CONFIG.ballSize >= state.rightY &&
    nextBallY <= state.rightY + GAME_CONFIG.paddleHeight
  ) {
    nextBallX = rightPaddleX - GAME_CONFIG.ballSize;
    state.ballVX = -Math.abs(state.ballVX);
    reflectBall(state, state.rightY);
  }

  const leftPaddleX = GAME_CONFIG.paddleMargin;
  if (
    state.ballVX < 0 &&
    nextBallX <= leftPaddleX + GAME_CONFIG.paddleWidth &&
    nextBallX + GAME_CONFIG.ballSize >= leftPaddleX &&
    nextBallY + GAME_CONFIG.ballSize >= state.leftY &&
    nextBallY <= state.leftY + GAME_CONFIG.paddleHeight
  ) {
    nextBallX = leftPaddleX + GAME_CONFIG.paddleWidth;
    state.ballVX = Math.abs(state.ballVX);
    reflectBall(state, state.leftY);
  }

  state.ballX = nextBallX;
  state.ballY = nextBallY;

  if (state.ballX < 0) {
    state.rightScore += 1;
    resetBall(state, 'right');
  } else if (state.ballX + GAME_CONFIG.ballSize > GAME_CONFIG.width) {
    state.leftScore += 1;
    resetBall(state, 'left');
  }

  if (!state.gameOver && (state.leftScore >= GAME_CONFIG.scoreLimit || state.rightScore >= GAME_CONFIG.scoreLimit)) {
    state.gameOver = true;
    state.winner = state.leftScore > state.rightScore ? 'Left Player' : 'Right Player';
  }

  const snapshot = serializeState(room);
  room.pendingSnapshot = snapshot;
  room.history.push({
    frame: state.frame,
    snapshot,
  });
  if (room.history.length > HISTORY_SIZE) {
    room.history.shift();
  }

  if (state.frame - room.lastBroadcastFrame >= BROADCAST_INTERVAL) {
    broadcastState(room);
    room.lastBroadcastFrame = state.frame;
  }
}

function serializeState(room) {
  const { state } = room;
  return {
    frame: state.frame,
    timestamp: Date.now(),
    ballX: state.ballX,
    ballY: state.ballY,
    ballVX: state.ballVX,
    ballVY: state.ballVY,
    leftPaddleY: state.leftY,
    rightPaddleY: state.rightY,
    leftScore: state.leftScore,
    rightScore: state.rightScore,
    gameOver: state.gameOver,
    winner: state.winner,
    leftInputFrame: room.inputs.left.frame,
    rightInputFrame: room.inputs.right.frame,
    leftInput: {
      up: Boolean(room.inputs.left.up),
      down: Boolean(room.inputs.left.down),
    },
    rightInput: {
      up: Boolean(room.inputs.right.up),
      down: Boolean(room.inputs.right.down),
    },
    sequence: room.sequence += 1,
  };
}

function broadcastState(room) {
  const snapshot = room.pendingSnapshot || serializeState(room);
  const payload = { channel: 'state', type: 'state', state: snapshot };
  room.pendingSnapshot = null;
  Object.values(room.players).forEach((player) => {
    if (player) player.sendJSON(payload, { reliable: false });
  });
}

function handleMessage(connection, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch (error) {
    connection.sendJSON({ channel: 'control', type: 'error', message: 'Invalid JSON payload.' }, { reliable: true });
    return;
  }

  switch (message.type) {
    case 'createRoom':
      handleCreateRoom(connection);
      break;
    case 'joinRoom':
      handleJoinRoom(connection, message.roomId);
      break;
    case 'input':
      handlePlayerInput(connection, message);
      break;
    case 'ping':
      connection.sendJSON({
        channel: 'control',
        type: 'pong',
        id: message.id || null,
        clientTime: message.clientTime || null,
        serverTime: Date.now(),
      }, { reliable: true });
      break;
    default:
      connection.sendJSON({ channel: 'control', type: 'error', message: `Unknown message type: ${message.type}` }, { reliable: true });
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

  log('[ws] client connected', req.socket.remoteAddress);

  connection.on('message', (data) => handleMessage(connection, data));
  connection.on('close', () => {
    log('[ws] client disconnected', connection.id);
    connection.destroyed = true;
    connection.clearQueues();
    leaveRoom(connection);
  });
  connection.on('error', (error) => {
    log('[ws] client error', connection.id, error?.message || error);
    connection.destroyed = true;
    connection.clearQueues();
    leaveRoom(connection);
  });

  if (head && head.length) {
    connection.handleData(head);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Pong multiplayer authoritative server is running.\n');
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    acceptWebSocket(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  log(`Authoritative WebSocket server listening on ws://localhost:${PORT}`);
});

setInterval(() => {
  rooms.forEach((room) => {
    simulateRoom(room);
  });
}, 1000 / SIM_TICK_RATE);
