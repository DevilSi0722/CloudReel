// Startup always checks each available mount once. The preference controls only
// periodic checks; neither source exposes background work as foreground UI.
export class LibraryRefresh {
  constructor(scanner, {baiduConnected, automatic, setTimer = setInterval, clearTimer = clearInterval}) {
    Object.assign(this, {scanner, baiduConnected, automatic, setTimer, clearTimer});
    this.startedRoots = new Set(); this.stopped = false;
    this.startupRoots = new Set(scanner.roots().map(root => root.id));
  }
  available() {
    return this.scanner.roots().filter(root => root.enabled !== false && (root.source === 'local' || this.baiduConnected()));
  }
  startup() {
    if(this.stopped || this.scanner.state.cancelled && this.scanner.state.running) return;
    const roots = this.available().filter(root => this.startupRoots.has(root.id) && !this.startedRoots.has(root.id));
    if(!roots.length) return;
    this.scanner.refresh(roots.map(root => root.id), {background: true});
    for(const root of roots) this.startedRoots.add(root.id);
  }
  tick() {
    if(this.stopped || this.scanner.state.running) return;
    // A restored connection may become usable after the initial login probe.
    this.startup();
    if(!this.automatic() || this.scanner.state.running) return;
    const ids = this.available().map(root => root.id);
    if(ids.length) this.scanner.refresh(ids, {background: true});
  }
  start() {
    if(this.timer || this.stopped) return;
    this.startup();this.timer = this.setTimer(() => this.tick(), 15 * 60000);this.timer?.unref?.();
  }
  stop() {this.stopped = true;if(this.timer) this.clearTimer(this.timer);this.timer = null;}
}
