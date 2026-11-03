// Finish local work without allowing a network request or a child process to
// keep an invisible Electron application alive indefinitely.
export class AppShutdown {
  constructor({app,prepare=[],cleanup=[],persist=()=>{},dispose=()=>{},timeout=6000}) {
    Object.assign(this,{app,prepare,cleanup,persist,dispose,timeout});
    this.started=false;this.ready=false;
  }
  bind(window) {
    this.app.on('before-quit',event=>this.handle(event));
    window.on('close',event=>{
      if(this.ready)return;
      event.preventDefault();
      this.app.quit();
    });
  }
  handle(event) {
    if(this.ready)return;
    event.preventDefault();
    if(this.started)return;
    this.started=true;
    this.timer=setTimeout(()=>this.finish(),this.timeout);
    for(const task of this.prepare){try{task();}catch{}}
    try{this.persist();}catch{}
    void Promise.allSettled(this.cleanup.map(task=>Promise.resolve().then(task))).then(()=>this.finish());
  }
  finish() {
    if(this.ready)return;
    this.ready=true;clearTimeout(this.timer);
    try{this.persist();}catch{}
    try{this.dispose();}catch{}
    // app.quit preserves Electron's normal exit and updater lifecycle. Keep a
    // final bound in case a stale hidden window prevents that second quit.
    setTimeout(()=>this.app.exit(0),1000).unref?.();
    this.app.quit();
  }
}
