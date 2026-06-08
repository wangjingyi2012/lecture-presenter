// sidebar.js — Section navigation sidebar (v2 schema)
const Sidebar = {
  currentIndex: 0,
  onSectionChange: null,

  // Chinese numerals
  _toChineseNumeral(n) {
    const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
                     '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
    return numerals[n] || (n + 1).toString();
  },

  init(sections, onSectionChange) {
    this.onSectionChange = onSectionChange;
    const list = document.getElementById('week-list');
    list.innerHTML = '';

    sections.forEach((section, index) => {
      const li = document.createElement('li');
      li.dataset.index = index;
      li.innerHTML = `<span class="week-num">${this._toChineseNumeral(index)}</span><span>${this._escapeHtml(section.title)}</span>`;
      li.addEventListener('click', () => this.selectSection(index));
      list.appendChild(li);
    });
  },

  selectSection(index) {
    this.currentIndex = index;
    document.querySelectorAll('#week-list li').forEach(li => {
      li.classList.toggle('active', parseInt(li.dataset.index) === index);
    });
    if (this.onSectionChange) this.onSectionChange(index);
  },

  setCourseInfo(title, subtitle) {
    document.getElementById('course-title').textContent = title;
    document.getElementById('course-subtitle').textContent = subtitle;
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },
};
