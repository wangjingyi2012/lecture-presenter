// video-player.js — Video playback via Tauri asset protocol
const VideoPlayer = {
  init() {
    document.getElementById('video-close').addEventListener('click', () => this.close());
    document.getElementById('video-modal').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  },

  open(title, url) {
    document.getElementById('video-title').textContent = title;
    document.getElementById('video-modal').classList.remove('hidden');

    const video = document.getElementById('video-player');
    video.src = url;
    video.focus();
  },

  close() {
    const video = document.getElementById('video-player');
    video.pause();
    video.src = '';
    document.getElementById('video-modal').classList.add('hidden');
  }
};
