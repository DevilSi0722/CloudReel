// Shared by native mpv input and renderer input, so changing keyboard focus
// cannot leave a temporary speed behind or apply two different seek distances.
export class PlayerGestures {
  constructor({session, control, seek, pause, notify, rightPressed, delay = setTimeout, clear = clearTimeout}) {
    Object.assign(this, {session, control, seek, pause, notify, rightPressed, delay, clear});
    this.right = null; this.click = null;
  }
  rightDown(source='default') {
    if (this.right || !this.session()) return;
    const hold = {session: this.session(), speed: this.session().speed, boosting: false, source};
    this.right = hold;
    hold.timer = this.delay(() => {
      if (this.right !== hold || this.session() !== hold.session || hold.session.paused) return;
      if (this.rightPressed?.() === false) {this.rightUp(); return;}
      hold.boosting = true; hold.session.boosting = true;
      this.control({speed: Math.max(3, hold.speed)}); this.notify();
    }, 350);
    // A lost keyup must become a tap or restore temporary speed, never latch
    // 3x playback. This also rejects a delayed native keydown after release.
    if (this.rightPressed) {
      const release = () => {
        if (this.right !== hold) return;
        if (this.session() !== hold.session) {this.rightUp(true); return;}
        if (this.rightPressed() === false) {this.rightUp(); return;}
        hold.releaseTimer = this.delay(release, 40);
      };
      hold.releaseTimer = this.delay(release, 40);
    }
  }
  rightUp(cancel = false, source) {
    const hold = this.right; if (!hold) return;
    if(source!==undefined&&source!==hold.source)return;
    this.clear(hold.timer); this.clear(hold.releaseTimer); this.right = null;
    if (this.session() !== hold.session) return;
    hold.session.boosting = false;
    if (hold.boosting) this.control({speed: hold.speed});
    else if (!cancel) this.seek((hold.session.seek?.pending ? hold.session.seek.target : hold.session.position) + 5);
    this.notify();
  }
  singleClick() {
    if (this.clickBlocked) return;
    this.clear(this.click?.timer);
    const click = {session: this.session()};
    click.timer = this.delay(() => {
      this.click = null;
      if (this.session() === click.session && click.session) this.pause();
    }, 310);
    this.click = click;
  }
  cancelClick() {this.clear(this.click?.timer); this.click = null;}
  doubleClick() {
    this.cancelClick(); this.clickBlocked = true; this.clear(this.unblock);
    this.unblock = this.delay(() => {this.clickBlocked = false;}, 310);
  }
  cancel() {this.rightUp(true); this.cancelClick(); this.clear(this.unblock); this.clickBlocked = false;}
}
