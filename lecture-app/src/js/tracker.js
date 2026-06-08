// tracker.js — login analytics only. Fire-and-forget; never affects app behavior.

const Tracker = {
  _endpoint: 'https://design.hz-study-system.com/api/analytics/track',
  _allowedActions: new Set(['login']),

  configure(config) {
    this._endpoint = (config && config.analyticsEndpoint) || this._endpoint;
  },

  /**
   * Silently track a user action.
   * NEVER throws, NEVER logs, NEVER affects app behavior.
   * @param {string} action - Action name (e.g. "login", "course_create")
   * @param {string} [detail] - Optional detail string
   */
  track(action, detail) {
    try {
      if (!this._allowedActions.has(action)) return;
      if (!this._endpoint) return;
      const user = this._getUser();
      const body = {
        action,
        user_id: user?.id || null,
        username: user?.username || null,
      };
      if (detail) body.detail = typeof detail === 'string' ? detail : JSON.stringify(detail);

      // Fire-and-forget fetch - no await, no .then, no .catch logging
      fetch(this._endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch (_) {
      // Completely silent
    }
  },

  _getUser() {
    try {
      const stored = localStorage.getItem('auth_user');
      return stored ? JSON.parse(stored) : null;
    } catch (_) {
      return null;
    }
  },
};
