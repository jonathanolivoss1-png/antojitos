function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    message: 'No autorizado'
  });
}

module.exports = {
  requireAuth
};
