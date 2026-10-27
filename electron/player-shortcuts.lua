-- Complex bindings provide key release, which input.conf commands cannot do.
local function send(action) mp.commandv('script-message', 'cloudreel', action) end
mp.add_forced_key_binding('RIGHT', 'cloudreel-right', function(event)
    if event.event == 'down' then send('right-down')
    elseif event.event == 'up' then send('right-up')
    elseif event.event == 'press' then send('forward') end
end, {complex = true})
mp.observe_property('focused', 'bool', function(_, focused)
    if focused == false then send('cancel') end
end)
