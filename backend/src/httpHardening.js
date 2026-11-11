// Response headers and request logging, kept dependency-free.

// An API should never be framed, sniffed or used to run script, so say so on every response.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.removeHeader('X-Powered-By');
  // Only meaningful (and only sent) once the request really arrived over TLS.
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

// One line per request: method, path WITHOUT the query string (which can carry tokens), status,
// duration and client address. Bodies and headers are never logged.
function requestLogger(options = {}) {
  const write = options.write || ((line) => console.log(line));
  const skip = options.skip || ['/api/health'];
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const path = (req.originalUrl || req.url || '').split('?')[0];
      if (skip.includes(path)) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      write(`${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms ${req.ip || '-'}`);
    });
    next();
  };
}

module.exports = { securityHeaders, requestLogger };
