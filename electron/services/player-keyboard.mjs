// The owner receives keys before Chromium dispatches them. Native mpv and the
// transparent control surface share the same gesture state in PlayerService.
export function bindPlayerKeyboard(window,player) {
  const shortcut=action=>{void player.shortcut(action,'owner').catch(()=>{});};
  const input=(event,input)=>{
    if(!player.session)return;
    const name=input.key.toLowerCase();
    if(name==='arrowright'&&input.type==='keyUp'){event.preventDefault();shortcut('right-up');return;}
    if(input.control||input.alt||input.meta||input.isComposing)return;
    const actions={' ':'pause',k:'pause',p:'pause',arrowleft:'backward',arrowup:'volume-up',arrowdown:'volume-down',f:'fullscreen',enter:'fullscreen',m:'mute',q:'exit','[':'previous',']':'next','?':'help',escape:'escape'};
    // Cancelling keyDown here makes Electron suppress its matching keyUp.
    // The player viewport consumes the DOM event after Chromium sees it.
    if(name==='arrowright'){if(input.type==='keyDown'&&!input.isAutoRepeat)shortcut('right-down');return;}
    const action=actions[name];if(!action)return;
    event.preventDefault();
    if(input.type==='keyDown'&&(!input.isAutoRepeat||['arrowleft','arrowup','arrowdown'].includes(name)))shortcut(action);
  };
  window.webContents.on('before-input-event',input);
  window.on('blur',()=>shortcut('cancel'));
}
