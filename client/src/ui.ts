// DOM-side UI: menu, color picker, leaderboard, snake name labels, PWA install.
//
// Snake name labels are persistent — one div per snake, recycled in place.
// (Previous version innerHTML'd the container and built a new div every
// frame for every snake. At 60fps × 11 snakes that's 660 div/sec of pure
// garbage. This was the worst hot spot in the original main.ts.)

import { COLORS } from './config';

interface NameLabel { identity: string; div: HTMLDivElement; name: string }

export class UI {
  private nameLabels = new Map<string, NameLabel>();
  private myIdentity = '';

  // ============================================================
  // Menu
  // ============================================================

  buildColorPicker(initialIndex: number, onPick: (index: number) => void) {
    const picker = document.getElementById('color-picker');
    if (!picker) return initialIndex;
    let selected = initialIndex;
    COLORS.forEach((color, i) => {
      const div = document.createElement('div');
      div.className = 'color-option' + (i === selected ? ' selected' : '');
      div.style.backgroundColor = color;
      div.dataset.color = color;
      div.addEventListener('click', () => {
        selected = i;
        picker.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
        div.classList.add('selected');
        onPick(i);
      });
      picker.appendChild(div);
    });
    return selected;
  }

  attachArrowKeyColorNav(
    currentIndex: () => number,
    onChange: (newIndex: number) => void
  ) {
    window.addEventListener('keydown', (e) => {
      if (!this.isMenuVisible()) return;
      if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const perRow = 10;
      let next = currentIndex();
      switch (e.key) {
        case 'ArrowRight': next = (next + 1) % COLORS.length; break;
        case 'ArrowLeft':  next = (next - 1 + COLORS.length) % COLORS.length; break;
        case 'ArrowDown':  next = Math.min(COLORS.length - 1, next + perRow); break;
        case 'ArrowUp':    next = Math.max(0, next - perRow); break;
      }
      e.preventDefault();
      onChange(next);
      this.highlightColorOption(next);
    });
  }

  highlightColorOption(index: number) {
    const picker = document.getElementById('color-picker');
    if (!picker) return;
    const options = picker.querySelectorAll<HTMLElement>('.color-option');
    options.forEach((el, i) => {
      el.classList.toggle('selected', i === index);
    });
  }

  getSelectedColor(): string {
    const el = document.querySelector<HTMLElement>('.color-option.selected');
    return el?.dataset.color ?? COLORS[0];
  }

  getNameInput(): string {
    return (document.getElementById('name-input') as HTMLInputElement | null)?.value.trim() || 'Anonymous';
  }

  // ============================================================
  // Visibility
  // ============================================================

  showMenu()   { document.getElementById('menu')?.classList.remove('hidden'); }
  hideMenu()   { document.getElementById('menu')?.classList.add('hidden'); }
  isMenuVisible(): boolean {
    const m = document.getElementById('menu');
    return !!m && !m.classList.contains('hidden');
  }
  hideLoading() { document.getElementById('loading')?.classList.add('hidden'); }

  showLeaderboard() { document.getElementById('leaderboard')?.classList.remove('hidden'); }
  hideLeaderboard() { document.getElementById('leaderboard')?.classList.add('hidden'); }
  isLeaderboardVisible(): boolean {
    const lb = document.getElementById('leaderboard');
    return !!lb && !lb.classList.contains('hidden');
  }

  hideSpeaker()  { document.getElementById('speaker-icon')?.classList.add('hidden'); }
  showSpeaker()  { document.getElementById('speaker-icon')?.classList.remove('hidden'); }
  setSpeakerIcon(unmuted: boolean) {
    const el = document.getElementById('speaker-icon');
    if (el) el.textContent = unmuted ? '🔊' : '🔇';
  }

  showDeathScreen(killerName: string, finalScore: number) {
    const stats = document.getElementById('death-stats');
    if (stats) stats.innerHTML = `You were killed by ${killerName || 'unknown'}<br>Final Score: ${finalScore}`;
    document.getElementById('death-screen')?.classList.remove('hidden');
  }
  hideDeathScreen() { document.getElementById('death-screen')?.classList.add('hidden'); }
  isDeathScreenVisible(): boolean {
    const d = document.getElementById('death-screen');
    return !!d && !d.classList.contains('hidden');
  }

  // ============================================================
  // Leaderboard
  // ============================================================

  renderLeaderboard(entries: Array<{ name: string; score: number; identity?: string }>, myIdentity: string) {
    const list = document.getElementById('leaderboard-list');
    if (!list) return;

    list.innerHTML = '';
    const top = entries.slice(0, 10);
    top.forEach((entry, index) => {
      const rank = index + 1;
      const isMe = entry.identity === myIdentity;
      const row = document.createElement('div');
      row.className = 'leaderboard-item' + (isMe ? ' current-player' : '');
      row.innerHTML = `
        <span class="leaderboard-rank">#${rank}</span>
        <span class="leaderboard-name">${entry.name}</span>
        <span class="leaderboard-score">${entry.score}</span>
      `;
      list.appendChild(row);
    });

    // If I'm not in the top 10, show me at the bottom
    const myRank = entries.findIndex(e => e.identity === myIdentity) + 1;
    if (myRank > 10 && myRank > 0) {
      const me = entries[myRank - 1];
      const divider = document.createElement('div');
      divider.className = 'leaderboard-divider';
      list.appendChild(divider);
      const row = document.createElement('div');
      row.className = 'leaderboard-item current-player';
      row.innerHTML = `
        <span class="leaderboard-rank">#${myRank}</span>
        <span class="leaderboard-name">${me.name}</span>
        <span class="leaderboard-score">${me.score}</span>
      `;
      list.appendChild(row);
    }
  }

  // ============================================================
  // Snake name labels — the persistent-div perf fix
  // ============================================================

  setMyIdentity(identity: string) { this.myIdentity = identity; }

  removeNameLabel(identity: string) {
    const label = this.nameLabels.get(identity);
    if (!label) return;
    label.div.remove();
    this.nameLabels.delete(identity);
  }

  // Updates positions and visibility of all snake name labels in place.
  // No DOM thrash — divs are reused across frames.
  // Names are positioned directly above the rendered head. The head's
  // actual screen position is computed by the renderer (with map-wrap
  // handling and headShift in the direction of movement); the label just
  // lifts it upward by HEAD_TOP_OFFSET and clamps the result to the
  // screen edges so the label is never partially clipped.
  updateNameLabels(
    players: Array<{ identity: string; name: string; screenX: number; screenY: number; alive: boolean }>,
    viewport: { width: number; height: number },
    canvas: { width: number; height: number }
  ) {
    const container = document.getElementById('snake-names');
    if (!container) return;
    const seen = new Set<string>();

    // Lift the label above the head. 20 units clears the head's back edge
    // for every heading (max back-extent is ~16.4 in the diagonal case).
    const HEAD_TOP_OFFSET = 20;
    // Pad the label inward from the screen edge so the full label stays
    // on-screen even when the snake's head is right at the edge of the
    // viewport. Without this the label is centered on the head and half
    // of it gets clipped, making the visible portion look offset from
    // the head ("label too far from the snake").
    const EDGE_PAD = 4;

    for (const p of players) {
      if (p.identity === this.myIdentity) continue;
      seen.add(p.identity);

      let label = this.nameLabels.get(p.identity);
      if (!label) {
        const div = document.createElement('div');
        div.className = 'snake-name';
        container.appendChild(div);
        label = { identity: p.identity, div, name: '' };
        this.nameLabels.set(p.identity, label);
      }

      // Update text only when it changes
      if (label.name !== p.name) {
        label.div.textContent = p.name;
        label.name = p.name;
      }

      // Measure the actual label size so the clamp uses the real width
      // (snake names vary in length). The label's position is set every
      // frame anyway, so re-measuring has no extra layout cost.
      const rect = label.div.getBoundingClientRect();
      const halfW = rect.width / 2;
      const labelH = rect.height;

      // Anchor the label's bottom-center at the head's screen position,
      // lifted upward by HEAD_TOP_OFFSET. The CSS `transform:
      // translate(-50%, -100%)` centers the text on the anchor and pins
      // its bottom edge at `top`.
      let anchorX = p.screenX;
      let anchorY = p.screenY - HEAD_TOP_OFFSET;

      // Clamp to the screen bounds so the label is always fully visible.
      // When the head is near the edge of the screen the label is shifted
      // inward by up to halfW/labelH — this means it sits a few pixels
      // away from the head at the edge, but it never gets half-clipped.
      if (anchorX < halfW + EDGE_PAD) anchorX = halfW + EDGE_PAD;
      else if (anchorX > canvas.width - halfW - EDGE_PAD) anchorX = canvas.width - halfW - EDGE_PAD;
      if (anchorY < labelH + EDGE_PAD) anchorY = labelH + EDGE_PAD;

      // Hide if the head is well off-screen (snake is not visible).
      // The renderer culls off-screen snakes, so showing a label for an
      // invisible head would be misleading.
      const headOffScreen =
        p.screenX < -100 || p.screenX > canvas.width + 100 ||
        p.screenY < -100 || p.screenY > canvas.height + 100;

      if (headOffScreen || !p.alive) {
        if (label.div.style.display !== 'none') label.div.style.display = 'none';
      } else {
        if (label.div.style.display === 'none') label.div.style.display = '';
        label.div.style.left = `${anchorX}px`;
        label.div.style.top = `${anchorY}px`;
      }
    }

    // Remove labels for snakes that no longer exist
    for (const [id, label] of this.nameLabels) {
      if (!seen.has(id)) {
        label.div.remove();
        this.nameLabels.delete(id);
      }
    }
  }

  // ============================================================
  // PWA install prompt
  // ============================================================

  setupPwaInstallPrompt(onInstalled: () => void) {
    let deferred: Event | null = null;
    const isMobile = /Mobi|Android|iPad|iPhone|iPod/i.test(navigator.userAgent);
    const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
                  (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                         (navigator as any).standalone === true;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      (window as any).deferredInstallPrompt = e;
      this.showInstallButton('Add to Home Screen');
    });

    window.addEventListener('appinstalled', () => {
      deferred = null;
      (window as any).deferredInstallPrompt = null;
      this.hideInstallButton();
      onInstalled();
    });

    if (isStandalone) {
      // Already installed — no prompt needed, just lock orientation.
      onInstalled();
      return;
    }

    if (isMobile) this.checkAndShowInstallButton(isIOS);
  }

  private showInstallButton(label: string) {
    const btn = document.querySelector<HTMLElement>('.install-btn');
    if (btn) {
      btn.textContent = label;
      btn.style.display = 'block';
    }
  }

  private hideInstallButton() {
    const btn = document.querySelector<HTMLElement>('.install-btn');
    if (btn) btn.style.display = 'none';
  }

  private checkAndShowInstallButton(isIOS: boolean) {
    const menu = document.getElementById('menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.querySelector('.install-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'play-btn install-btn';
    // Always visible on mobile so users know they can install to get rid
    // of the browser top bar. On iOS there's no beforeinstallprompt, so
    // the button click reveals the Share -> Add to Home Screen steps.
    btn.textContent = isIOS ? 'Add to Home Screen' : 'Install App';
    btn.style.marginBottom = '0.5rem';
    btn.style.display = 'block';
    btn.style.fontSize = '0.95rem';
    btn.style.padding = '0.6rem 1.2rem';

    const hint = document.createElement('p');
    hint.className = 'install-hint';
    hint.textContent = isIOS
      ? 'Removes the browser bar and gives you fullscreen play.'
      : 'Install for fullscreen play with no browser bar.';
    hint.style.fontSize = '0.75rem';
    hint.style.color = 'rgba(255,255,255,0.55)';
    hint.style.marginTop = '-0.25rem';
    hint.style.marginBottom = '0.5rem';
    hint.style.textAlign = 'center';
    hint.style.lineHeight = '1.3';

    const panel = menu.querySelector('.menu-panel');
    if (!panel) return;
    panel.appendChild(btn);
    panel.appendChild(hint);

    btn.onclick = async () => {
      const prompt = (window as any).deferredInstallPrompt;
      if (prompt) {
        prompt.prompt();
        const { outcome } = await prompt.userChoice;
        if (outcome === 'accepted') {
          this.hideInstallButton();
          hint.remove();
        }
        (window as any).deferredInstallPrompt = null;
      } else if (isIOS) {
        // iOS Safari never fires beforeinstallprompt. The user has to
        // use the system Share sheet. Show inline instructions instead
        // of an alert so it works in fullscreen PWA too.
        this.showIosInstallInstructions();
      }
    };
  }

  private showIosInstallInstructions() {
    // Remove any existing overlay first.
    const existing = document.getElementById('ios-install-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ios-install-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(0,0,0,0.85);
      display: flex; align-items: center; justify-content: center;
      padding: 1.5rem;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      background: #1a1a2e; color: white;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 16px; padding: 1.5rem;
      max-width: 340px; width: 100%;
      font-family: 'Nunito', sans-serif;
      text-align: center;
    `;
    card.innerHTML = `
      <div style="font-family:'Fredoka One',cursive; font-size:1.4rem; color:#00d9ff; margin-bottom:0.75rem;">
        Install snek.io
      </div>
      <div style="font-size:0.95rem; line-height:1.5; margin-bottom:1rem; color:rgba(255,255,255,0.9);">
        1. Tap the <b>Share</b> button below<br>
        <span style="font-size:1.4rem;">⬆️</span><br>
        2. Scroll down and tap<br>
        <b>"Add to Home Screen"</b> ➕<br>
        3. Tap <b>Add</b>
      </div>
      <div style="font-size:0.8rem; color:rgba(255,255,255,0.6); margin-bottom:1rem;">
        Launches in fullscreen — no browser bar.
      </div>
    `;

    const close = document.createElement('button');
    close.textContent = 'Got it';
    close.className = 'play-btn';
    close.style.fontSize = '0.95rem';
    close.style.padding = '0.5rem 1.5rem';
    close.onclick = () => overlay.remove();
    card.appendChild(close);

    overlay.appendChild(card);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }

  enableLandscapeOrientation() {
    if (screen.orientation && 'lock' in screen.orientation) {
      (screen.orientation.lock as (type: string) => Promise<void>)('landscape')
        .catch(() => { /* lock not supported or denied */ });
    }
  }
}
