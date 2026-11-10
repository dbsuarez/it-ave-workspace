const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const config = require('./src/config');
const db = require('./src/db');

const authRoutes = require('./src/routes/auth');
const channelRoutes = require('./src/routes/channels');
const messageRoutes = require('./src/routes/messages');
const userRoutes = require('./src/routes/users');
const filesRoutes = require('./src/routes/files');
const notesRoutes = require('./src/routes/notes');
const chatSockets = require('./src/sockets/chat');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
// The Electron desktop client is loaded from file:// - its Origin is `null`.
// Reflect the request origin (JWT is the real security boundary).
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Attach io to request for use in routes
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/notes', notesRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Socket.io connection
io.on('connection', (socket) => {
  chatSockets(io, socket);
});

// Start server
const PORT = config.PORT;
server.listen(PORT, () => {
  console.log(`IT Avenue Workspace backend running on port ${PORT}`);
});

module.exports = { app, server, io };
