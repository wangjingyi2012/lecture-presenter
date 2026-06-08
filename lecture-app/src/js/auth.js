// auth.js — Authentication state management and login UI
window.Auth = {
  serverUrl: 'https://www.hz-study-system.com',
  membershipUrl: 'https://www.hz-study-system.com/membership',
  _token: null,
  _user: null,
  _captchaVerified: false,
  _registerCaptchaVerified: false,
  _benefits: null,

  log(msg) {
    console.log(msg);
    if (window.errorLogs) {
      window.errorLogs.push(`[AUTH] ${msg}`);
    }
  },

  async init(config = {}) {
    try {
      this.serverUrl = config.authServer || this.serverUrl;
      this.membershipUrl = config.membershipUrl || this.membershipUrl;
      this.log('Auth init');
      this._token = localStorage.getItem('auth_token');
      const savedUser = localStorage.getItem('auth_user');
      if (savedUser) {
        try {
          this._user = JSON.parse(savedUser);
        } catch (e) {
          this._user = null;
        }
      }

      this._bindEvents();
      this._initCaptcha();
      this._renderTitlebarButton();

      // Validate stored token with server (non-blocking)
      if (this.serverUrl && this._token) {
        this._validateToken().catch(() => {});
      }
    } catch (err) {
      this.log('Init error: ' + err);
    }
  },

  // --- Public API ---

  getToken() {
    return this._token;
  },

  getUser() {
    return this._user;
  },

  isLoggedIn() {
    return !!(this._token && this._user);
  },

  isAdmin() {
    return this.isLoggedIn() && this._user.role === 'admin';
  },

  getMembership() {
    const m = this._user?.membership;
    return (m !== null && m !== undefined) ? Number(m) : 1;
  },

  getMembershipName() {
    return { 1: 'Basic', 2: 'Pro', 3: 'Ultra' }[this.getMembership()] || 'Basic';
  },

  _getMembershipIcon(level) {
    if (level === 3) {
      return `<svg width="16" height="16" viewBox="0 0 16 16">
        <path d="M2 11h12l-1.5-6L9 8 8 5 7 8 3.5 5z" fill="#FF9800"/>
        <rect x="2" y="11.5" width="12" height="1.5" rx="0.5" fill="#FF9800"/>
        <circle cx="8" cy="5" r="1" fill="#FFC107"/>
        <circle cx="3.5" cy="5" r="1" fill="#FFC107"/>
        <circle cx="12.5" cy="5" r="1" fill="#FFC107"/>
      </svg>`;
    }
    if (level === 2) {
      return `<svg width="16" height="16" viewBox="0 0 16 16">
        <path d="M8 1L2 3.5V8c0 3 2.5 5.5 6 6.5 3.5-1 6-3.5 6-6.5V3.5L8 1z" fill="#2196F3"/>
        <path d="M8 4l.9 2.6H11.5L9.3 8.1l.9 2.6L8 9.2 5.8 10.7l.9-2.6L4.5 6.6H7.1z" fill="white" opacity="0.9"/>
      </svg>`;
    }
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 1L2 3.5V8c0 3 2.5 5.5 6 6.5 3.5-1 6-3.5 6-6.5V3.5L8 1z" stroke="#8b8b8b" stroke-width="1.2" fill="none"/>
    </svg>`;
  },

  async login(username, password) {
    try {
      const resp = await fetch(`${this.serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await resp.json();

      if (!resp.ok || !data.success) {
        return { success: false, detail: data.detail || '登录失败' };
      }

      this._setAuth(data.token, data.user);
      Tracker.track('login', data.user.username);
      this.log('Login success: ' + data.user.username);
      return { success: true, user: data.user };
    } catch (err) {
      this.log('Login error: ' + err);
      return { success: false, detail: '网络连接失败，请检查网络后重试' };
    }
  },

  async register(username, password, email) {
    try {
      const body = { username, password, email };

      const resp = await fetch(`${this.serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await resp.json();

      if (!resp.ok || !data.success) {
        return { success: false, detail: data.detail || '注册失败' };
      }

      this._setAuth(data.token, data.user);
      this.log('Register success: ' + data.user.username);
      return { success: true, user: data.user };
    } catch (err) {
      this.log('Register error: ' + err);
      return { success: false, detail: '网络连接失败，请检查网络后重试' };
    }
  },

  logout() {
    this._token = null;
    this._user = null;
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    this._renderTitlebarButton();
    this.log('Logged out');
  },

  // --- Modal Controls ---

  showLoginModal() {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    this._switchTab('login');
    this._clearForm();
  },

  hideLoginModal() {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    this._clearForm();
  },

  // --- Private Methods ---

  _setAuth(token, user) {
    this._token = token;
    this._user = user;
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
    this._renderTitlebarButton();
  },

  async _validateToken() {
    if (!this.serverUrl) return;
    try {
      const resp = await fetch(`${this.serverUrl}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${this._token}` }
      });

      if (!resp.ok) {
        this.log('Token validation failed, clearing auth');
        this.logout();
        return;
      }

      const user = await resp.json();
      this._user = user;
      localStorage.setItem('auth_user', JSON.stringify(user));
      this._renderTitlebarButton();
      // Also refresh profile if it's open
      if (!document.getElementById('profile-modal')?.classList.contains('hidden')) {
        this._loadBenefits();
      }
      this.log('Token validated: ' + user.username);
    } catch (err) {
      // Network error — keep local state, app works offline
      this.log('Token validation skipped (offline): ' + err);
    }
  },

  _bindEvents() {
    // Modal close
    const overlay = document.getElementById('auth-modal-overlay');
    if (overlay) overlay.addEventListener('click', () => this.hideLoginModal());

    const closeBtn = document.getElementById('auth-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', () => this.hideLoginModal());

    // Tab switching
    const loginTab = document.getElementById('auth-tab-login');
    const registerTab = document.getElementById('auth-tab-register');
    if (loginTab) loginTab.addEventListener('click', () => this._switchTab('login'));
    if (registerTab) registerTab.addEventListener('click', () => this._switchTab('register'));

    // Login form submit
    const loginBtn = document.getElementById('auth-login-btn');
    if (loginBtn) loginBtn.addEventListener('click', () => this._handleLogin());

    // Register form submit
    const registerBtn = document.getElementById('auth-register-btn');
    if (registerBtn) registerBtn.addEventListener('click', () => this._handleRegister());

    // Enter key support
    const loginForm = document.getElementById('auth-login-form');
    if (loginForm) {
      loginForm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._handleLogin();
        }
      });
    }

    const registerForm = document.getElementById('auth-register-form');
    if (registerForm) {
      registerForm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._handleRegister();
        }
      });
    }
  },

  _switchTab(tab) {
    const loginTab = document.getElementById('auth-tab-login');
    const registerTab = document.getElementById('auth-tab-register');
    const loginForm = document.getElementById('auth-login-form');
    const registerForm = document.getElementById('auth-register-form');

    if (!loginTab || !registerTab || !loginForm || !registerForm) return;

    if (tab === 'login') {
      loginTab.classList.add('active');
      registerTab.classList.remove('active');
      loginForm.style.display = 'block';
      registerForm.style.display = 'none';
    } else {
      loginTab.classList.remove('active');
      registerTab.classList.add('active');
      loginForm.style.display = 'none';
      registerForm.style.display = 'block';
    }

    this._clearError();
  },

  _clearForm() {
    const fields = [
      'auth-login-username', 'auth-login-password',
      'auth-register-username', 'auth-register-password',
      'auth-register-confirm', 'auth-register-email'
    ];
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    this._clearError();
    this._resetCaptcha();
  },

  _initCaptcha() {
    const track = document.getElementById('captcha-track');
    const thumb = document.getElementById('captcha-thumb');
    const fill = document.getElementById('captcha-fill');
    if (!track || !thumb || !fill) return;

    let dragging = false;
    let startX = 0;
    let thumbLeft = 0;
    const maxLeft = () => track.offsetWidth - thumb.offsetWidth;

    thumb.addEventListener('mousedown', (e) => {
      if (this._captchaVerified) return;
      dragging = true;
      startX = e.clientX;
      thumbLeft = parseInt(thumb.style.left || '0');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      let newLeft = Math.max(0, Math.min(maxLeft(), thumbLeft + dx));
      thumb.style.left = newLeft + 'px';
      fill.style.width = (newLeft + thumb.offsetWidth) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const currentLeft = parseInt(thumb.style.left || '0');
      const max = maxLeft();
      // If dragged to >= 90% of track, verify success
      if (currentLeft >= max * 0.9) {
        thumb.style.left = max + 'px';
        fill.style.width = '100%';
        this._captchaVerified = true;
        // Show success state
        document.getElementById('captcha-track').style.display = 'none';
        document.getElementById('captcha-success').style.display = 'flex';
      } else {
        // Reset - spring back
        thumb.style.transition = 'left 0.3s';
        fill.style.transition = 'width 0.3s';
        thumb.style.left = '0px';
        fill.style.width = '0px';
        setTimeout(() => {
          thumb.style.transition = 'none';
          fill.style.transition = 'none';
        }, 300);
      }
    });

    // Register captcha
    const regTrack = document.getElementById('register-captcha-track');
    const regThumb = document.getElementById('register-captcha-thumb');
    const regFill = document.getElementById('register-captcha-fill');
    if (regTrack && regThumb && regFill) {
      let regDragging = false;
      let regStartX = 0;
      let regThumbLeft = 0;
      const regMaxLeft = () => regTrack.offsetWidth - regThumb.offsetWidth;

      regThumb.addEventListener('mousedown', (e) => {
        if (this._registerCaptchaVerified) return;
        regDragging = true;
        regStartX = e.clientX;
        regThumbLeft = parseInt(regThumb.style.left || '0');
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!regDragging) return;
        const dx = e.clientX - regStartX;
        let newLeft = Math.max(0, Math.min(regMaxLeft(), regThumbLeft + dx));
        regThumb.style.left = newLeft + 'px';
        regFill.style.width = (newLeft + regThumb.offsetWidth) + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!regDragging) return;
        regDragging = false;
        const currentLeft = parseInt(regThumb.style.left || '0');
        const max = regMaxLeft();
        if (currentLeft >= max * 0.9) {
          regThumb.style.left = max + 'px';
          regFill.style.width = '100%';
          this._registerCaptchaVerified = true;
          document.getElementById('register-captcha-track').style.display = 'none';
          document.getElementById('register-captcha-success').style.display = 'flex';
        } else {
          regThumb.style.transition = 'left 0.3s';
          regFill.style.transition = 'width 0.3s';
          regThumb.style.left = '0px';
          regFill.style.width = '0px';
          setTimeout(() => {
            regThumb.style.transition = 'none';
            regFill.style.transition = 'none';
          }, 300);
        }
      });
    }
  },

  _resetCaptcha() {
    this._captchaVerified = false;
    const track = document.getElementById('captcha-track');
    const success = document.getElementById('captcha-success');
    const thumb = document.getElementById('captcha-thumb');
    const fill = document.getElementById('captcha-fill');
    if (track) track.style.display = '';
    if (success) success.style.display = 'none';
    if (thumb) { thumb.style.left = '0px'; thumb.style.transition = 'none'; }
    if (fill) { fill.style.width = '0px'; fill.style.transition = 'none'; }

    this._registerCaptchaVerified = false;
    const regTrack = document.getElementById('register-captcha-track');
    const regSuccess = document.getElementById('register-captcha-success');
    const regThumb = document.getElementById('register-captcha-thumb');
    const regFill = document.getElementById('register-captcha-fill');
    if (regTrack) regTrack.style.display = '';
    if (regSuccess) regSuccess.style.display = 'none';
    if (regThumb) { regThumb.style.left = '0px'; regThumb.style.transition = 'none'; }
    if (regFill) { regFill.style.width = '0px'; regFill.style.transition = 'none'; }
  },

  _showError(msg) {
    const el = document.getElementById('auth-error');
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  },

  _clearError() {
    const el = document.getElementById('auth-error');
    if (el) {
      el.textContent = '';
      el.style.display = 'none';
    }
  },

  _setLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = loading ? '请稍候...' : (btnId === 'auth-login-btn' ? '登录' : '注册');
  },

  async _handleLogin() {
    const username = (document.getElementById('auth-login-username')?.value || '').trim();
    const password = document.getElementById('auth-login-password')?.value || '';

    if (!username) {
      this._showError('请输入用户名');
      return;
    }
    if (!password) {
      this._showError('请输入密码');
      return;
    }
    if (!this._captchaVerified) {
      this._showError('请先完成滑动验证');
      return;
    }

    this._clearError();
    this._setLoading('auth-login-btn', true);

    const result = await this.login(username, password);

    this._setLoading('auth-login-btn', false);

    if (result.success) {
      this.hideLoginModal();
    } else {
      this._showError(result.detail);
    }
  },

  async _handleRegister() {
    const username = (document.getElementById('auth-register-username')?.value || '').trim();
    const password = document.getElementById('auth-register-password')?.value || '';
    const confirm = document.getElementById('auth-register-confirm')?.value || '';
    const email = (document.getElementById('auth-register-email')?.value || '').trim();

    if (!username) {
      this._showError('请输入用户名');
      return;
    }
    if (!password) {
      this._showError('请输入密码');
      return;
    }
    if (password.length < 6) {
      this._showError('密码至少6位');
      return;
    }
    if (password !== confirm) {
      this._showError('两次密码不一致');
      return;
    }
    if (!email) {
      this._showError('请输入邮箱');
      return;
    }
    if (!email.includes('@')) {
      this._showError('请输入有效的邮箱地址');
      return;
    }
    if (!this._registerCaptchaVerified) {
      this._showError('请先完成滑动验证');
      return;
    }

    this._clearError();
    this._setLoading('auth-register-btn', true);

    const result = await this.register(username, password, email);

    this._setLoading('auth-register-btn', false);

    if (result.success) {
      this.hideLoginModal();
    } else {
      this._showError(result.detail);
    }
  },

  _renderTitlebarButton() {
    const container = document.getElementById('auth-titlebar');
    if (!container) return;

    if (this.isLoggedIn()) {
      const level = this.getMembership();
      const membershipName = this.getMembershipName();
      const membershipIcon = this._getMembershipIcon(level);
      const membershipLabel = level > 1 ? `${membershipName}会员` : 'Basic';

      container.innerHTML = `
        <div class="auth-user-wrapper">
          <button class="auth-user-btn" id="auth-user-btn" title="${this._escapeHtml(this._user.username)}">
            <span class="auth-avatar">${this._user.username.charAt(0).toUpperCase()}</span>
            <span class="auth-username">${this._escapeHtml(this._user.username)}</span>
            <span class="auth-membership-badge" title="${membershipName}">${membershipIcon}</span>
          </button>
          <div class="auth-dropdown" id="auth-dropdown" style="display:none;">
            <div class="auth-dropdown-header">
              <span class="auth-dropdown-name">${this._escapeHtml(this._user.username)}</span>
              ${this._user.email ? `<span class="auth-dropdown-email">${this._escapeHtml(this._user.email)}</span>` : ''}
              ${this._user.role === 'admin' ? '<span class="auth-dropdown-role">管理员</span>' : ''}
              <span class="auth-dropdown-membership">${membershipIcon}<span>${membershipLabel}</span></span>
            </div>
            <button class="auth-dropdown-item" id="auth-notif-btn">通知</button>
            <button class="auth-dropdown-item" id="auth-about-btn">关于</button>
            <div class="auth-dropdown-divider"></div>
            <button class="auth-dropdown-item" id="auth-profile-btn">个人中心</button>
            <button class="auth-dropdown-item" id="auth-logout-btn">退出登录</button>
          </div>
        </div>
      `;

      const userBtn = document.getElementById('auth-user-btn');
      const dropdown = document.getElementById('auth-dropdown');
      if (userBtn && dropdown) {
        userBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        });
      }

      const logoutBtn = document.getElementById('auth-logout-btn');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
          this.logout();
          const dd = document.getElementById('auth-dropdown');
          if (dd) dd.style.display = 'none';
        });
      }

      const profileBtn = document.getElementById('auth-profile-btn');
      if (profileBtn) {
        profileBtn.addEventListener('click', () => {
          const dd = document.getElementById('auth-dropdown');
          if (dd) dd.style.display = 'none';
          this.showProfileModal();
        });
      }

      const notifBtn = document.getElementById('auth-notif-btn');
      if (notifBtn) {
        notifBtn.addEventListener('click', () => {
          const dd = document.getElementById('auth-dropdown');
          if (dd) dd.style.display = 'none';
          window.NotificationCenter?.toggle();
        });
      }

      const aboutBtn2 = document.getElementById('auth-about-btn');
      if (aboutBtn2) {
        aboutBtn2.addEventListener('click', () => {
          const dd = document.getElementById('auth-dropdown');
          if (dd) dd.style.display = 'none';
          document.getElementById('about-modal')?.classList.remove('hidden');
        });
      }

      // Hide standalone notification center and about button when logged in
      const notifCenter = document.getElementById('notification-center');
      if (notifCenter) notifCenter.style.display = 'none';
      const aboutBtn = document.getElementById('btn-about');
      if (aboutBtn) aboutBtn.style.display = 'none';

      // Close dropdown on outside click
      document.addEventListener('click', this._closeDropdownHandler);
    } else {
      container.innerHTML = `
        <button class="auth-login-trigger" id="auth-login-trigger" title="登录">
          <span class="auth-avatar-empty">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm5.21 1.413A6.962 6.962 0 0 0 8 7a6.962 6.962 0 0 0-5.21 2.413A5.99 5.99 0 0 0 2 12.83V14h12v-1.17a5.99 5.99 0 0 0-.79-3.417z"/>
            </svg>
          </span>
          <span>登录</span>
        </button>
      `;

      const loginTrigger = document.getElementById('auth-login-trigger');
      if (loginTrigger) {
        loginTrigger.addEventListener('click', () => this.showLoginModal());
      }

      // Hide notification center when not logged in, show about button
      const notifCenter = document.getElementById('notification-center');
      if (notifCenter) notifCenter.style.display = 'none';
      const aboutBtn = document.getElementById('btn-about');
      if (aboutBtn) aboutBtn.style.display = '';

      document.removeEventListener('click', this._closeDropdownHandler);
    }
  },

  _closeDropdownHandler(e) {
    const dropdown = document.getElementById('auth-dropdown');
    const userBtn = document.getElementById('auth-user-btn');
    if (dropdown && userBtn && !userBtn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },

  // --- Profile Modal ---

  showProfileModal() {
    if (!this.isLoggedIn()) return;
    const modal = document.getElementById('profile-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    this._renderProfile();
    this._loadBenefits();
    this._bindProfileEvents();
  },

  hideProfileModal() {
    const modal = document.getElementById('profile-modal');
    if (!modal) return;
    modal.classList.add('hidden');
  },

  _renderProfile() {
    const user = this._user;
    if (!user) return;

    const avatar = document.getElementById('profile-avatar');
    if (avatar) avatar.textContent = user.username.charAt(0).toUpperCase();

    const username = document.getElementById('profile-username');
    if (username) username.textContent = user.username;

    const email = document.getElementById('profile-email');
    if (email) email.textContent = user.email || '';

    const role = document.getElementById('profile-role');
    if (role) role.textContent = user.role === 'admin' ? '管理员' : '普通用户';

    // Clear password fields
    ['profile-current-password', 'profile-new-password', 'profile-confirm-password'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const msg = document.getElementById('profile-password-msg');
    if (msg) msg.style.display = 'none';
  },

  async _loadBenefits() {
    const card = document.getElementById('profile-membership-card');
    const list = document.getElementById('profile-benefits-list');
    if (!card || !list) return;

    const level = this.getMembership();
    const icon = this._getMembershipIcon(level);

    try {
      if (this.serverUrl) {
        const resp = await fetch(`${this.serverUrl}/api/membership/benefits`);
        if (!resp.ok) throw new Error('Failed');
        this._benefits = await resp.json();
      }
    } catch (e) {
      // Use cached or fallback
      if (!this._benefits) {
        this._benefits = [
          { level: 1, name_cn: '基础会员', description: '免费注册用户', benefits: { features: ['每日 10 次 LectureAI 问答', '仅可使用内置基础模板', '无云存储'] } },
          { level: 2, name_cn: '专业会员', description: '进阶用户', benefits: { features: ['每日 50 次问答', '全部精美模板', '2GB 云存储'] } },
          { level: 3, name_cn: '超级会员', description: '最高等级', benefits: { features: ['每日 100 次问答', '1TB 云存储', '优先队列', '无水印导出', '专属客服'] } },
        ];
      }
    }

    const current = this._benefits.find(b => b.level === level) || this._benefits[0];

    card.className = 'profile-membership-card level-' + level;
    card.innerHTML = `
      <div>${icon}</div>
      <div style="flex:1;">
        <div class="profile-membership-name">${this._escapeHtml(current.name_cn)}</div>
        <div class="profile-membership-desc">${this._escapeHtml(current.description || '')}</div>
      </div>
      <a href="#" class="profile-upgrade-link" id="profile-upgrade-link">
        ${level < 3 ? '升级会员 →' : '当前最高等级'}
      </a>
    `;

    // Bind upgrade link click handler
    const upgradeLink = document.getElementById('profile-upgrade-link');
    if (upgradeLink && level < 3 && this.membershipUrl) {
      upgradeLink.addEventListener('click', (e) => {
        e.preventDefault();
        // Open membership page in external browser
        if (window.__TAURI__?.shell?.open) {
          window.__TAURI__.shell.open(this.membershipUrl);
        } else {
          window.open(this.membershipUrl, '_blank');
        }
      });
    } else if (upgradeLink && level < 3) {
      upgradeLink.style.display = 'none';
    }

    // Render benefits comparison table
    const allFeatures = [];
    this._benefits.forEach(b => {
      const features = b.benefits?.features || [];
      features.forEach(f => {
        if (!allFeatures.find(af => af.text === f)) {
          allFeatures.push({ text: f, minLevel: b.level });
        }
      });
    });

    list.innerHTML = allFeatures.map(f => {
      const hasAccess = level >= f.minLevel;
      return `<div class="profile-benefit-item">
        <span class="${hasAccess ? 'profile-benefit-check' : 'profile-benefit-lock'}">
          ${hasAccess ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>'}
        </span>
        <span style="${hasAccess ? '' : 'opacity:0.5;'}">${this._escapeHtml(f.text)}</span>
      </div>`;
    }).join('');
  },

  _bindProfileEvents() {
    const close = document.getElementById('profile-modal-close');
    if (close) close.onclick = () => this.hideProfileModal();

    const overlay = document.getElementById('profile-modal-overlay');
    if (overlay) overlay.onclick = () => this.hideProfileModal();

    const changeBtn = document.getElementById('profile-change-password-btn');
    if (changeBtn) changeBtn.onclick = () => this._handleChangePassword();
  },

  async _handleChangePassword() {
    if (!this.serverUrl) {
      this._showProfileMsg('账号服务暂不可用', 'error');
      return;
    }
    const current = document.getElementById('profile-current-password')?.value || '';
    const newPwd = document.getElementById('profile-new-password')?.value || '';
    const confirm = document.getElementById('profile-confirm-password')?.value || '';

    if (!current) { this._showProfileMsg('请输入当前密码', 'error'); return; }
    if (!newPwd) { this._showProfileMsg('请输入新密码', 'error'); return; }
    if (newPwd.length < 6) { this._showProfileMsg('新密码至少6位', 'error'); return; }
    if (newPwd !== confirm) { this._showProfileMsg('两次新密码不一致', 'error'); return; }

    try {
      const resp = await fetch(`${this.serverUrl}/api/auth/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._token}`
        },
        body: JSON.stringify({ current_password: current, new_password: newPwd })
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        this._showProfileMsg('密码修改成功', 'success');
        ['profile-current-password', 'profile-new-password', 'profile-confirm-password'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
      } else {
        this._showProfileMsg(data.detail || '修改失败', 'error');
      }
    } catch (e) {
      this._showProfileMsg('网络连接失败', 'error');
    }
  },

  _showProfileMsg(msg, type) {
    const el = document.getElementById('profile-password-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'profile-msg ' + type;
    el.style.display = 'block';
  }
};
