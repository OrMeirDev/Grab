import React from 'react';
import { createRoot } from 'react-dom/client';
import AppShell from './app/AppShell.jsx';
import './design/styles.css';
import './design/theme.css';
import { startLiquidGlass } from './design/glassMotion.js';

createRoot(document.getElementById('root')).render(<AppShell />);

startLiquidGlass();
