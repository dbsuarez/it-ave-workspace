const express = require('express');
const cors = require('cors');
const { parseOrigins, corsOptions } = require('./src/corsPolicy');
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
const searchRoutes = require('./src/routes/search');
const listsRoutes = require('./src/routes/lists');
const canvasesRoutes = require('./src/routes/canvases');
const canvasRoutes = require('./src/routes/canvas');
const peopleRoutes = require('./src/routes/people');
const moderationRoutes = require('./src/routes/moderation');
const activityRoutes = require('./src/routes/activity');
const settingsRoutes = require('./src/routes/settings');
const conversationRoutes = require('./src/routes/conversations');
const messageEditRoutes = require('./src/routes/messageEdits');
const savedRoutes = require('./src/routes/saved');
const reminderRoutes = require('./src/routes/reminders');
const adminRoutes = require('./src/routes/admin');
const hrRoutes = require('./src/routes/hr');
const rolesRoutes = require('./src/routes/roles');
const leaveRoutes = require('./src/routes/leave');
const attendanceRoutes = require('./src/routes/attendance');
const scheduledRoutes = require('./src/routes/scheduled');
const channelLinkRoutes = require('./src/routes/channelLinks');
const userGroupRoutes = require('./src/routes/userGroups');
const webhookRoutes = require('./src/routes/webhooks');
const migrations = require('./src/migrations');
const { parseTrustProxy } = require('./src/rateLimit');
const chatSockets = require('./src/sockets/chat');
const { securityHeaders, requestLogger } = require('./src/httpHardening');

const app = express();

// Behind a reverse proxy, set TRUST_PROXY (for example 1) so rate limits see each person's
// real address instead of the proxy's.
const trustProxy = parseTrustProxy(config.TRUST_PROXY);
if (trustProxy !== false) app.set('trust proxy', trustProxy);
const server = http.createServer(app);

// Only the desktop app (file://), local tools and the sites in CORS_ORIGINS may call from a browser.
const corsPolicy = corsOptions({ configured: parseOrigins(config.CORS_ORIGINS), frontendUrl: config.FRONTEND_URL });

const io = new Server(server, {
  cors: { ...corsPolicy, methods: ['GET', 'POST'] },
});

// Middleware
// The Electron desktop client is loaded from file:// - its Origin is `null`, which the policy allows.
app.use(cors(corsPolicy));
app.use(securityHeaders);

// The phone app (a web app installed from /m/). It is plain files served by this same server, so it needs its own,
// looser page policy than the API's "nothing may load" one: scripts, styles, pictures and the socket from this server only.
const MOBILE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; "
  + "manifest-src 'self'; worker-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
app.use('/m', (req, res, next) => {
  res.setHeader('Content-Security-Policy', MOBILE_CSP);
  res.setHeader('Cache-Control', 'no-cache'); // always check for a new version; the service worker handles offline
  next();
}, express.static(require('path').join(__dirname, 'public', 'm')));
if (config.LOG_REQUESTS) app.use(requestLogger());
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
app.use('/api/channels', channelLinkRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/messages', messageEditRoutes);
app.use('/api/users', userRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/lists', listsRoutes);
app.use('/api/canvases', canvasesRoutes);
app.use('/api/canvas', canvasRoutes);
app.use('/api/people', peopleRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/saved', savedRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/hr', hrRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/scheduled', scheduledRoutes);
app.use('/api/user-groups', userGroupRoutes);
app.use('/api/webhooks', webhookRoutes.manage);
app.use('/api/hooks', webhookRoutes.receive);

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
Promise.resolve()
  .then(() => migrations.reduce((chain, sql) => chain.then(() => db.query(sql)), Promise.resolve()))
  .then(() => {
    server.listen(PORT, () => {
      console.log(`IT Avenue Workspace backend running on port ${PORT}`);
    });
    reminderRoutes.startReminderScheduler(io);
    scheduledRoutes.startScheduledMessageRunner(io);
    require('./src/canvasTrash').schedulePurge(db.query.bind(db));
  })
  .catch((err) => {
    console.error('Failed to apply startup database migrations:', err);
    process.exitCode = 1;
  });

module.exports = { app, server, io };
