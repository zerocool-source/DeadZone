// DOM HUD: points, round, ammo, prompts, damage feedback, screens.
export class HUD {
  constructor() {
    this.el = {
      round: document.getElementById('round'),
      points: document.getElementById('points'),
      weaponName: document.getElementById('weapon-name'),
      ammo: document.getElementById('ammo'),
      reloadHint: document.getElementById('reload-hint'),
      prompt: document.getElementById('prompt'),
      announce: document.getElementById('announce'),
      vignette: document.getElementById('damage-vignette'),
      splatter: document.getElementById('blood-splatter'),
      hitmarker: document.getElementById('hitmarker'),
      hud: document.getElementById('hud'),
      startScreen: document.getElementById('start-screen'),
      gameoverScreen: document.getElementById('gameover-screen'),
      gameoverStats: document.getElementById('gameover-stats'),
      pausedScreen: document.getElementById('paused-screen'),
    };
    this._hitTimer = null;
    this._announceTimer = null;
  }

  setRound(r) {
    this.el.round.textContent = r;
    this.announce(`ROUND ${r}`);
  }

  setPoints(p) { this.el.points.textContent = p; }

  pointPop(amount) {
    const pop = document.createElement('div');
    pop.className = 'point-pop' + (amount < 0 ? ' red' : '');
    pop.textContent = (amount > 0 ? '+' : '') + amount;
    pop.style.left = (110 + Math.random() * 70) + 'px';
    pop.style.bottom = (30 + Math.random() * 20) + 'px';
    this.el.hud.appendChild(pop);
    setTimeout(() => pop.remove(), 900);
  }

  setWeapon(w) {
    this.el.weaponName.textContent = w.name;
    this.el.weaponName.classList.toggle('upgraded', w.upgraded);
    this.el.ammo.innerHTML = `<span class="mag">${w.mag}</span> <span class="reserve">/ ${w.reserve}</span>`;
    this.el.ammo.classList.toggle('low', w.mag <= Math.max(2, w.magSize * 0.2));
    this.el.reloadHint.style.visibility = (w.mag === 0 && w.reserve > 0) ? 'visible' : 'hidden';
  }

  prompt(html) {
    if (html) {
      this.el.prompt.innerHTML = html;
      this.el.prompt.style.visibility = 'visible';
    } else {
      this.el.prompt.style.visibility = 'hidden';
    }
  }

  announce(text, ms = 2600) {
    clearTimeout(this._announceTimer);
    this.el.announce.textContent = text;
    this.el.announce.style.opacity = 1;
    this._announceTimer = setTimeout(() => { this.el.announce.style.opacity = 0; }, ms);
  }

  hitmarker() {
    this.el.hitmarker.style.opacity = 1;
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => { this.el.hitmarker.style.opacity = 0; }, 90);
  }

  // health 0..100 — vignette creeps in as health drops, flashes on hit
  setHealth(health, justHit) {
    const t = 1 - health / 100;
    this.el.vignette.style.opacity = Math.min(1, t * 1.3);
    if (justHit) {
      this.el.splatter.style.transition = 'none';
      this.el.splatter.style.opacity = 0.85;
      requestAnimationFrame(() => {
        this.el.splatter.style.transition = 'opacity 0.6s';
        this.el.splatter.style.opacity = 0;
      });
    }
  }

  showStart(show) { this.el.startScreen.classList.toggle('hidden', !show); }
  showPaused(show) { this.el.pausedScreen.classList.toggle('hidden', !show); }
  showGameOver(stats) {
    this.el.gameoverStats.innerHTML =
      `You survived to round <b>${stats.round}</b><br>` +
      `Kills: <b>${stats.kills}</b> &nbsp; Points earned: <b>${stats.totalPoints}</b>`;
    this.el.gameoverScreen.classList.remove('hidden');
  }
  hideGameOver() { this.el.gameoverScreen.classList.add('hidden'); }
}
