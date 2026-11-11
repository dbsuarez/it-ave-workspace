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
const searchRoutes = require('./src/routes/search');
const listsRoutes = require('./src/routes/lists');
const canvasesRoutes = require('./src/routes/canvases');
const canvasRoutes = require('./src/routes/canvas');
const moderationRoutes = require('./src/routes/moderation');
const activityRoutes = require('./src/routes/activity');
const settingsRoutes = require('./src/routes/settings');
const conversationRoutes = require('./src/routes/conversations');
const messageEditRoutes = require('./src/routes/messageEdits');
const savedRoutes = require('./src/routes/saved');
const reminderRoutes = require('./src/routes/reminders');
const adminRoutes = require('./src/routes/admin');
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
app.use(securityHeaders);
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
app.use('/api/moderation', moderationRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/saved', savedRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/admin', adminRoutes);
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
db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0')
  .then(() => db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT FALSE'))
  .then(() => db.query("ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'member'"))
  .then(() => db.query('ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP WITH TIME ZONE'))
  .then(() => db.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS slowmode_seconds INTEGER NOT NULL DEFAULT 0'))
  .then(() => db.query(`
    DO $$ BEGIN
      ALTER TABLE channel_members ADD CONSTRAINT channel_members_role_check
        CHECK (role IN ('member', 'moderator'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS moderation_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      default_timeout_minutes INTEGER NOT NULL DEFAULT 5 CHECK (default_timeout_minutes BETWEEN 1 AND 10080),
      max_timeout_minutes INTEGER NOT NULL DEFAULT 10080 CHECK (max_timeout_minutes BETWEEN 1 AND 10080),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      CHECK (default_timeout_minutes <= max_timeout_minutes)
    )
  `))
  .then(() => db.query('INSERT INTO moderation_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING'))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS channel_timeouts (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason VARCHAR(500) NOT NULL DEFAULT '',
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `))
  .then(() => db.query('CREATE INDEX IF NOT EXISTS idx_channel_timeouts_active ON channel_timeouts(channel_id, user_id, expires_at DESC)'))
  .then(() => db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_timeouts_channel_user ON channel_timeouts(channel_id, user_id)'))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS message_reports (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason VARCHAR(500) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `))
  .then(() => db.query('CREATE INDEX IF NOT EXISTS idx_message_reports_queue ON message_reports(channel_id, status, created_at DESC)'))
  .then(() => db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reports_open_reporter
    ON message_reports(message_id, reporter_id) WHERE status = 'open' AND reporter_id IS NOT NULL`))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS moderation_audit_log (
      id BIGSERIAL PRIMARY KEY,
      channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(50) NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `))
  .then(() => db.query('CREATE INDEX IF NOT EXISTS idx_moderation_audit_channel_created ON moderation_audit_log(channel_id, created_at DESC)'))
  .then(() => db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMP WITH TIME ZONE'))
  .then(() => db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL'))
  .then(() => db.query(`CREATE INDEX IF NOT EXISTS idx_messages_pinned_channel
    ON messages(channel_id, pinned_at DESC)
    WHERE pinned_at IS NOT NULL`))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS channel_lists (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS channel_list_items (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES channel_lists(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      is_completed BOOLEAN NOT NULL DEFAULT FALSE,
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      due_date DATE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `))
  .then(() => db.query('CREATE INDEX IF NOT EXISTS idx_channel_lists_channel_id ON channel_lists(channel_id)'))
  .then(() => db.query('CREATE INDEX IF NOT EXISTS idx_channel_list_items_list_id ON channel_list_items(list_id)'))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS channel_canvases (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `))
  .then(() => db.query('CREATE INDEX IF NOT EXISTS idx_channel_canvases_channel_id ON channel_canvases(channel_id)'))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS canvases (
      id SERIAL PRIMARY KEY,
      kind VARCHAR(16) NOT NULL CHECK (kind IN ('channel', 'dm', 'standalone')),
      channel_id INTEGER NULL REFERENCES channels(id) ON DELETE CASCADE,
      dm_user_low INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
      dm_user_high INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(160) NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      CHECK (
        (kind = 'channel' AND channel_id IS NOT NULL)
        OR (kind = 'dm' AND dm_user_low IS NOT NULL AND dm_user_high IS NOT NULL)
        OR (kind = 'standalone' AND channel_id IS NULL AND dm_user_low IS NULL AND dm_user_high IS NULL)
      ),
      CHECK (dm_user_low IS NULL OR dm_user_low < dm_user_high)
    )
  `))
  .then(() => db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_canvases_channel ON canvases(channel_id) WHERE kind = 'channel'`))
  .then(() => db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_canvases_dm ON canvases(dm_user_low, dm_user_high) WHERE kind = 'dm'`))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS canvas_collaborators (
      canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'editor')),
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      PRIMARY KEY (canvas_id, user_id)
    )
  `))
  .then(() => db.query(`
    CREATE TABLE IF NOT EXISTS canvas_shares (
      id SERIAL PRIMARY KEY,
      canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      token VARCHAR(64) NOT NULL UNIQUE,
      role VARCHAR(16) NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'editor')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      expires_at TIMESTAMP WITH TIME ZONE
    )
  `))
  .then(() => db.query('CREATE INDEX IF NOT EXISTS idx_canvas_shares_token ON canvas_shares(token)'))
  .then(() => migrations.reduce((chain, sql) => chain.then(() => db.query(sql)), Promise.resolve()))
  .then(() => {
    server.listen(PORT, () => {
      console.log(`IT Avenue Workspace backend running on port ${PORT}`);
    });
    reminderRoutes.startReminderScheduler(io);
    scheduledRoutes.startScheduledMessageRunner(io);
  })
  .catch((err) => {
    console.error('Failed to apply startup database migrations:', err);
    process.exitCode = 1;
  });

module.exports = { app, server, io };
