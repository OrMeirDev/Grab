import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './theme.css';
import { startLiquidGlass } from './liquid-glass.js';

createRoot(document.getElementById('root')).render(<App />);

startLiquidGlass();
