import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import PlayerOverlayApp from './PlayerOverlayApp';
import './styles.css';
import './desktop.css';
const Root = location.hash === '#player-controls' ? PlayerOverlayApp : App;
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
